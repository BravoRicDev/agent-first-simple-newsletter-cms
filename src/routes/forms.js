import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { query } from "../db.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { sendEmail } from "../services/email.js";
import { renderEmail } from "../services/email-templates.js";
import { sendCsv } from "../services/csv.js";
import { searchSubmissions, extractEmailFromFields, upsertContact, addContactTag } from "../services/contacts.js";
import { subscribeEmail } from "../services/newsletter.js";
import { sendMetaCapiEvent, isMarketingConsentGranted } from "../services/tracking.js";
import { logger } from "../services/logger.js";
import { translate } from "../middleware/i18n.js";
import config from "../config.js";

const t = (key, vars) => translate(config.defaultLang, key, vars);

const router = Router();

const FIELD_TYPES = new Set(["text", "email", "tel", "textarea", "select", "radio", "checkbox"]);

// Chiave di campo derivata dall'etichetta (o passata dal builder): normalizzata
// per essere una chiave JSON sicura e stabile, con deduplica in caso di
// etichette ripetute/vuote nello stesso form.
function sanitizeFieldKey(raw, fallback, used) {
  let key = String(raw || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100) || fallback;
  let unique = key;
  let i = 2;
  while (used.has(unique)) unique = `${key}_${i++}`;
  used.add(unique);
  return unique;
}

// Il builder invia i campi come JSON serializzato lato client in un unico
// input nascosto (fields_json) — evita di dipendere dal parsing di array in
// notazione a parentesi quadre, non supportato da express.urlencoded({extended:false}).
function normalizeFields(raw) {
  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const used = new Set();
  return parsed
    .filter(f => f && typeof f.label === "string" && f.label.trim())
    .slice(0, 50)
    .map((f, i) => {
      const type = FIELD_TYPES.has(f.type) ? f.type : "text";
      const label = f.label.trim().slice(0, 255);
      const key = sanitizeFieldKey(f.key || f.label, `campo_${i + 1}`, used);
      const field = { key, label, type, required: !!f.required };
      if (type === "select" || type === "radio") {
        field.options = Array.isArray(f.options)
          ? f.options.map(o => String(o).trim().slice(0, 255)).filter(Boolean).slice(0, 50)
          : [];
      }
      return field;
    });
}

// Deve essere la chiave di un campo checkbox effettivamente presente nel
// form — altrimenti ignorata silenziosamente (es. campo rimosso dopo aver
// impostato l'opt-in).
function sanitizeOptinKey(fields, raw) {
  const key = String(raw || "").trim();
  if (!key) return null;
  const field = fields.find(f => f.key === key && f.type === "checkbox");
  return field ? key : null;
}

// Chiave del campo da cui ricavare il tag del contatto (newsletter_tag_key):
// deve esistere tra i campi del form, di qualunque tipo (a differenza
// dell'opt-in, qui il valore del campo è ciò che conta). Se il campo viene
// rimosso dopo la configurazione, la chiave è ignorata silenziosamente.
function sanitizeTagKey(fields, raw) {
  const key = String(raw || "").trim();
  if (!key) return null;
  const field = fields.find(f => f.key === key);
  return field ? key : null;
}

// Tag fisso opzionale (newsletter_tag_value): se presente, è IL tag da
// assegnare quando il campo newsletter_tag_key è valorizzato; se assente, il
// tag è il valore del campo stesso.
function sanitizeTagValue(raw) {
  return String(raw || "").trim().slice(0, 100) || null;
}

// Pagina di ringraziamento (redirect_url): path relativo (es. /grazie) o URL
// dello stesso dominio. Un valore non sicuro viene scartato silenziosamente
// (null = comportamento invariato: redirect a _redirect/referer/"/").
function sanitizeRedirect(raw, req) {
  const value = String(raw || "").trim().slice(0, 500);
  if (!value) return null;
  return isSafeRedirect(value, req) ? value : null;
}

// Logica di risoluzione del tag al submit. Regole:
// - campo non valorizzato (vuoto) → nessun tag;
// - checkbox spuntato ("1") → tag fisso se configurato, altrimenti nessuno
//   (un checkbox senza tag fisso non ha un valore significativo da usare);
// - campi a valore (text/select/radio/...) → tag fisso se configurato,
//   altrimenti il valore compilato/scelto.
function resolveFormTag(formDef, data) {
  const key = formDef?.newsletter_tag_key;
  if (!key) return null;
  const field = (formDef.fields || []).find(f => f.key === key);
  const raw = data[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const fixed = (formDef.newsletter_tag_value || "").trim();
  if (field?.type === "checkbox") {
    return raw === "1" ? (fixed || null) : null;
  }
  return fixed || String(raw).trim().slice(0, 100) || null;
}

function sanitizeFormSlug(raw) {
  return String(raw || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

const formLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  // Funzione (non oggetto statico): express-rate-limit la valuta per ogni
  // richiesta, quindi res.locals.t (impostato da i18nMiddleware) è disponibile.
  message: (req, res) => ({ error: res.locals.t("api.forms.tooManyAttempts") }),
  standardHeaders: true,
  legacyHeaders: false,
});

// I form integrati con fetch+FormData (pattern delle landing moderne, vedi
// {{form:slug}} e widget) arrivano come multipart/form-data, che
// express.urlencoded non parsaa → req.body vuoto → falso 400 "Nessun dato
// ricevuto". multer().none() parsaa i campi multipart (senza accettare
// file) e lascia passare invariati i content-type non multipart (urlencoded,
// JSON), così entrambi i client continuano a funzionare.
const formMultipart = multer({
  storage: multer.memoryStorage(),
  limits: { fieldSize: 200 * 1024 },
}).none();

// Anti-spam aggiuntivo oltre al rate-limit per minuto (formLimiter) e
// all'honeypot (_honeypot/website/url, vedi sotto): cap giornaliero per
// IP+sito e un'euristica su link ripetuti (spam "link stuffing").
const DAILY_SUBMISSIONS_PER_IP = 30;
const MAX_LINKS_PER_SUBMISSION = 3;

function countLinks(data) {
  let count = 0;
  for (const val of Object.values(data)) {
    const matches = val.match(/https?:\/\//g);
    if (matches) count += matches.length;
  }
  return count;
}

// Notifica non bloccante al proprietario del sito: legge site_variables
// 'form_notify_email' (chiave convenzionale, gestita dalla UI variabili di
// sito esistente). Se non configurata, non fa nulla.
async function notifyFormSubmission(siteId, formSlug, data) {
  try {
    const varResult = await query(
      "SELECT value FROM site_variables WHERE site_id = $1 AND key = 'form_notify_email'",
      [siteId]
    );
    const notifyTo = varResult.rows[0]?.value?.trim();
    if (!notifyTo) return;

    const siteResult = await query("SELECT name FROM sites WHERE id = $1", [siteId]);
    const siteName = siteResult.rows[0]?.name || t("email.formNotify.defaultSiteName", { siteId });

    // Escape HTML di chiave e valore: i dati arrivano da un form pubblico e
    // finiscono nel corpo della email al proprietario — senza escape un
    // attaccante inietta HTML arbitrario (link di phishing, <img onerror>).
    const escapeHtml = (s) => String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    const fieldsHtml = Object.entries(data)
      .map(([k, v]) => `<div style="font-size:13px;margin-bottom:4px;"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</div>`)
      .join("");

    const defaultHtml = `<p>${t("email.formNotify.intro", { formSlug })}</p>${fieldsHtml}<p style="margin-top:16px;font-size:12px;color:#666;">${t("email.formNotify.footer")}</p>`;

    // Override per sito (email_templates kind=form_notify) se configurato.
    const { subject, html } = await renderEmail(siteId, "form_notify", {
      vars: { formSlug, siteName, fieldsHtml, siteId },
      defaultSubject: "email.formNotify.subject",
      defaultBody: defaultHtml,
    });

    await sendEmail(notifyTo, subject, html);
  } catch (err) {
    logger.error(`Notifica form fallita (site=${siteId}, form=${formSlug}): ${err.message}`);
  }
}

// Accetta solo path relativi (niente "//", protocol-relative) o URL con lo
// stesso host della richiesta — mai un redirect a dominio esterno arbitrario.
function isSafeRedirect(target, req) {
  if (!target) return false;
  if (target.startsWith("/") && !target.startsWith("//")) return true;
  try {
    return new URL(target, `${req.protocol}://${req.get("host")}`).host === req.get("host");
  } catch {
    return false;
  }
}

// ── Admin ──────────────────────────────────────────────────────────────────

router.get("/admin/forms", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";

    const sites = isSuperadmin
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : [];

    let siteId = isSuperadmin && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;

    if (!siteId && isSuperadmin && sites.length > 0) {
      siteId = sites[0].id;
    }

    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    // Form costruiti dal builder (tabella forms), con conteggio invii aggregato.
    const definitions = (await query(
      `SELECT f.slug, f.name, f.updated_at, COALESCE(s.total, 0) AS total, s.last_submission
       FROM forms f
       LEFT JOIN (
         SELECT form_slug, COUNT(*) AS total, MAX(created_at) AS last_submission
         FROM form_submissions WHERE site_id = $1 GROUP BY form_slug
       ) s ON s.form_slug = f.slug
       WHERE f.site_id = $1
       ORDER BY f.updated_at DESC`,
      [siteId]
    )).rows;

    // Form con invii ma mai creati dal builder (scritti a mano in una pagina,
    // workflow preesistente) — restano visibili, solo senza azioni di modifica.
    const legacyForms = (await query(
      `SELECT form_slug, COUNT(*) AS total, MAX(created_at) AS last_submission
       FROM form_submissions
       WHERE site_id = $1 AND form_slug NOT IN (SELECT slug FROM forms WHERE site_id = $1)
       GROUP BY form_slug ORDER BY last_submission DESC`,
      [siteId]
    )).rows;

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];

    res.render("admin/forms/index", {
      definitions, legacyForms, site, sites, siteId, isSuperadmin,
      saved: req.query.saved === "1",
    });
  } catch (err) { next(err); }
});

router.get("/admin/forms/new", requireAuth, authorize("forms", "create"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    res.render("admin/forms/builder", { form: null, siteId, sites, isSuperadmin, error: null });
  } catch (err) { next(err); }
});

router.post("/admin/forms", requireAuth, authorize("forms", "create"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const slug = sanitizeFormSlug(req.body.slug || req.body.name);
    const name = String(req.body.name || "").trim().slice(0, 255);
    const fields = normalizeFields(req.body.fields_json);
    const submitLabel = String(req.body.submit_label || "").trim().slice(0, 100) || "Invia";
    const successMessage = String(req.body.success_message || "").trim().slice(0, 1000);
    const newsletterOptinKey = sanitizeOptinKey(fields, req.body.newsletter_optin_key);
    const newsletterTagKey = sanitizeTagKey(fields, req.body.newsletter_tag_key);
    const newsletterTagValue = sanitizeTagValue(req.body.newsletter_tag_value);
    const redirectUrl = sanitizeRedirect(req.body.redirect_url, req);
    const newsletterAutoConfirm = req.body.newsletter_auto_confirm === "1" || req.body.newsletter_auto_confirm === "on" || req.body.newsletter_auto_confirm === true;

    // "new"/"search" collidono con le route statiche /admin/forms/new e
    // /admin/forms/search — non raggiungibili in modifica se usati come slug.
    const RESERVED_SLUGS = new Set(["new", "search"]);
    if (!slug || !name || RESERVED_SLUGS.has(slug)) {
      return res.status(400).render("admin/forms/builder", {
        form: { name, slug, submit_label: submitLabel, success_message: successMessage, fields, newsletter_optin_key: newsletterOptinKey, newsletter_tag_key: newsletterTagKey, newsletter_tag_value: newsletterTagValue, redirect_url: redirectUrl, newsletter_auto_confirm: newsletterAutoConfirm },
        siteId, sites, isSuperadmin,
        error: RESERVED_SLUGS.has(slug) ? `Lo slug "${slug}" è riservato, scegline un altro.` : "Nome e slug sono obbligatori.",
      });
    }

    try {
      await query(
        `INSERT INTO forms (site_id, slug, name, submit_label, success_message, fields, newsletter_optin_key, newsletter_tag_key, newsletter_tag_value, redirect_url, newsletter_auto_confirm)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [siteId, slug, name, submitLabel, successMessage, JSON.stringify(fields), newsletterOptinKey, newsletterTagKey, newsletterTagValue, redirectUrl, newsletterAutoConfirm]
      );
    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).render("admin/forms/builder", {
          form: { name, slug, submit_label: submitLabel, success_message: successMessage, fields, newsletter_optin_key: newsletterOptinKey, newsletter_tag_key: newsletterTagKey, newsletter_tag_value: newsletterTagValue, redirect_url: redirectUrl, newsletter_auto_confirm: newsletterAutoConfirm },
          siteId, sites, isSuperadmin, error: `Esiste già un form con slug "${slug}" su questo sito.`,
        });
      }
      throw err;
    }

    res.redirect(`/admin/forms?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.get("/admin/forms/:slug/edit", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const result = await query("SELECT * FROM forms WHERE site_id = $1 AND slug = $2", [siteId, req.params.slug]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: "Form non trovato" });

    res.render("admin/forms/builder", { form: result.rows[0], siteId, sites, isSuperadmin, error: null });
  } catch (err) { next(err); }
});

router.post("/admin/forms/:slug", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const existing = await query("SELECT id FROM forms WHERE site_id = $1 AND slug = $2", [siteId, req.params.slug]);
    if (existing.rows.length === 0) return res.status(404).render("error", { message: "Form non trovato" });

    const name = String(req.body.name || "").trim().slice(0, 255);
    const fields = normalizeFields(req.body.fields_json);
    const submitLabel = String(req.body.submit_label || "").trim().slice(0, 100) || "Invia";
    const successMessage = String(req.body.success_message || "").trim().slice(0, 1000);
    const newsletterOptinKey = sanitizeOptinKey(fields, req.body.newsletter_optin_key);
    const newsletterTagKey = sanitizeTagKey(fields, req.body.newsletter_tag_key);
    const newsletterTagValue = sanitizeTagValue(req.body.newsletter_tag_value);
    const redirectUrl = sanitizeRedirect(req.body.redirect_url, req);
    const newsletterAutoConfirm = req.body.newsletter_auto_confirm === "1" || req.body.newsletter_auto_confirm === "on" || req.body.newsletter_auto_confirm === true;

    if (!name) {
      return res.status(400).render("admin/forms/builder", {
        form: { name, slug: req.params.slug, submit_label: submitLabel, success_message: successMessage, fields, newsletter_optin_key: newsletterOptinKey, newsletter_tag_key: newsletterTagKey, newsletter_tag_value: newsletterTagValue, redirect_url: redirectUrl, newsletter_auto_confirm: newsletterAutoConfirm },
        siteId, sites, isSuperadmin, error: "Il nome è obbligatorio.",
      });
    }

    await query(
      `UPDATE forms SET name = $1, submit_label = $2, success_message = $3, fields = $4, newsletter_optin_key = $5, newsletter_tag_key = $6, newsletter_tag_value = $7, redirect_url = $8, newsletter_auto_confirm = $9, updated_at = NOW()
       WHERE site_id = $10 AND slug = $11`,
      [name, submitLabel, successMessage, JSON.stringify(fields), newsletterOptinKey, newsletterTagKey, newsletterTagValue, redirectUrl, newsletterAutoConfirm, siteId, req.params.slug]
    );

    res.redirect(`/admin/forms?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.post("/admin/forms/:slug/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    // Elimina solo la definizione: gli invii già ricevuti restano (non c'è FK,
    // stesso comportamento pensato per i form scritti a mano che spariscono
    // dalla UI di editing ma non perdono lo storico).
    await query("DELETE FROM forms WHERE site_id = $1 AND slug = $2", [siteId, req.params.slug]);

    res.redirect(`/admin/forms?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.get("/admin/forms/search", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const term = (req.query.q || "").trim();
    const results = term.length >= 2 ? await searchSubmissions(siteId, term) : [];

    res.render("admin/forms/search", { results, term, siteId });
  } catch (err) { next(err); }
});

// Filtro data opzionale (from/to) su elenco e export: prima nessuno dei due
// esponeva alcun filtro, né in UI né come query param lato backend.
function buildSubmissionsDateFilter(siteId, slug, query) {
  const params = [siteId, slug];
  const conditions = ["site_id = $1", "form_slug = $2"];
  if (query.from) {
    params.push(query.from);
    conditions.push(`created_at >= $${params.length}::date`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  return { where: conditions.join(" AND "), params };
}

router.get("/admin/forms/:slug/submissions", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;

    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const { where, params } = buildSubmissionsDateFilter(siteId, req.params.slug, req.query);
    const submissions = (await query(
      `SELECT created_at, data, ip_address, referrer FROM form_submissions
       WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    )).rows;

    res.render("admin/forms/submissions", {
      submissions, formSlug: req.params.slug, siteId,
      filterFrom: req.query.from || "", filterTo: req.query.to || "",
    });
  } catch (err) { next(err); }
});

router.get("/admin/forms/:slug/submissions/export", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;

    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const { where, params } = buildSubmissionsDateFilter(siteId, req.params.slug, req.query);
    const submissions = (await query(
      `SELECT created_at, data, ip_address, referrer FROM form_submissions
       WHERE ${where} ORDER BY created_at DESC LIMIT 20000`,
      params
    )).rows;

    const dataKeys = [...new Set(submissions.flatMap(s => Object.keys(s.data || {})))];
    const columns = [
      { key: "created_at", label: "Data" },
      ...dataKeys.map(k => ({ key: k, label: k })),
      { key: "ip_address", label: "IP" },
      { key: "referrer", label: "Referrer" },
    ];
    const rows = submissions.map(s => ({
      created_at: new Date(s.created_at).toLocaleString("it-IT"),
      ...s.data,
      ip_address: s.ip_address,
      referrer: s.referrer,
    }));

    sendCsv(res, `${req.params.slug}.csv`, columns, rows);
  } catch (err) { next(err); }
});

// ── Public ─────────────────────────────────────────────────────────────────

// Una richiesta è AJAX se dichiara content-type JSON, se manda l'header
// classico X-Requested-With (jQuery/fetch wrappers) o se l'Accept esclude
// HTML. I client AJAX che inviano FormData (multipart/urlencoded) NON hanno
// content-type JSON — senza questo check riceverebbero un 302 invece del
// JSON che si aspettano.
function isAjaxRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json")) return true;
  if (req.headers["x-requested-with"] === "XMLHttpRequest") return true;
  const accept = String(req.headers["accept"] || "").toLowerCase();
  return accept.includes("application/json");
}

router.post("/forms/:siteId/:formSlug", formLimiter, resolveSite, formMultipart, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const formSlug = req.params.formSlug;

    const siteResult = await query("SELECT id FROM sites WHERE id = $1", [siteId]);
    if (siteResult.rows.length === 0) {
      return res.status(404).json({ error: res.locals.t("api.forms.notFound") });
    }

    if (req.body._honeypot || req.body.website || req.body.url) {
      return res.json({ ok: true });
    }

    const dailyCount = await query(
      `SELECT COUNT(*) AS c FROM form_submissions
       WHERE site_id = $1 AND ip_address = $2 AND created_at >= NOW() - INTERVAL '1 day'`,
      [siteId, req.ip]
    );
    if (parseInt(dailyCount.rows[0].c, 10) >= DAILY_SUBMISSIONS_PER_IP) {
      return res.status(429).json({ error: res.locals.t("api.forms.dailyCapReached") });
    }

    const { _honeypot, website, url, ...formData } = req.body;

    // Se il form è stato creato dal builder, accetta solo le chiavi dei campi
    // definiti (whitelist) — un form scritto a mano (nessuna riga in `forms`)
    // resta libero come prima, per non rompere niente di preesistente.
    const formDef = (await query(
      "SELECT fields, success_message, newsletter_optin_key, newsletter_tag_key, newsletter_tag_value, redirect_url, newsletter_auto_confirm FROM forms WHERE site_id = $1 AND slug = $2",
      [siteId, formSlug]
    )).rows[0];
    const allowedKeys = formDef ? new Set((formDef.fields || []).map(f => f.key)) : null;

    const cleanData = {};
    for (const [key, val] of Object.entries(formData)) {
      if (typeof val !== "string") continue;
      // I campi UTM standard (utm_source/medium/campaign/term/content) sono
      // SEMPRE accettati, anche se non dichiarati nel builder: la cattura
      // client-side del widget {{form:slug}} li inietta come hidden input →
      // il tracking funziona senza toccare i singoli form.
      if (allowedKeys ? (!allowedKeys.has(key) && !key.startsWith("utm_")) : key.length > 100) continue;
      cleanData[key] = val.slice(0, 5000);
    }

    if (Object.keys(cleanData).length === 0) {
      return res.status(400).json({ error: res.locals.t("api.forms.noDataReceived") });
    }

    // Euristica anti-spam (link stuffing): rifiuto silenzioso, stessa risposta
    // dell'honeypot, per non dare feedback utile a un bot.
    if (countLinks(cleanData) > MAX_LINKS_PER_SUBMISSION) {
      return res.json({ ok: true });
    }

    await query(
      `INSERT INTO form_submissions (site_id, form_slug, data, ip_address, user_agent, referrer)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        siteId,
        formSlug.slice(0, 255),
        JSON.stringify(cleanData),
        req.ip,
        (req.headers["user-agent"] || "").slice(0, 500),
        (req.headers["referer"] || "").slice(0, 500),
      ]
    );

    notifyFormSubmission(siteId, formSlug, cleanData).catch(() => {});

    // Collega l'invio a un contatto (CRM-lite) e, se questo form ha un campo
    // di consenso configurato ed è stato spuntato, iscrive alla newsletter
    // con lo stesso doppio opt-in dell'iscrizione manuale. Se il form ha un
    // campo tag configurato (newsletter_tag_key), assegna il tag al contatto
    // → le sequenze/campagne con target_tag corrispondente partono da sole.
    const email = extractEmailFromFields(formDef?.fields, cleanData);
    if (email) {
      upsertContact(siteId, email).catch(err => logger.error(`Contatti: upsert fallito (site=${siteId}, ${email}): ${err.message}`));
      if (formDef?.newsletter_optin_key && cleanData[formDef.newsletter_optin_key] === "1") {
        subscribeEmail(siteId, email, { autoConfirm: !!formDef?.newsletter_auto_confirm }).catch(err => logger.error(`Newsletter: auto-iscrizione da form fallita (site=${siteId}, ${email}): ${err.message}`));
      }
      const tag = resolveFormTag(formDef, cleanData);
      if (tag) {
        addContactTag(siteId, email, tag).catch(err => logger.error(`Contatti: tag da form fallito (site=${siteId}, ${email}, tag=${tag}): ${err.message}`));
      }

      // UTM sorgente: 5 parametri standard (Meta/Google), prima origine vince
      // (recordContactUtm è idempotente). Valori troncati a 255 come le colonne.
      const utm = {
        utm_source: String(cleanData.utm_source || req.query.utm_source || "").slice(0, 255) || null,
        utm_medium: String(cleanData.utm_medium || req.query.utm_medium || "").slice(0, 255) || null,
        utm_campaign: String(cleanData.utm_campaign || req.query.utm_campaign || "").slice(0, 255) || null,
        utm_term: String(cleanData.utm_term || req.query.utm_term || "").slice(0, 255) || null,
        utm_content: String(cleanData.utm_content || req.query.utm_content || "").slice(0, 255) || null,
      };
      if (utm.utm_source || utm.utm_medium || utm.utm_campaign || utm.utm_term || utm.utm_content) {
        import("../services/events.js").then(({ emitContactEvent }) => {
          (async () => {
            try {
              // UPSERT atomico: crea il contatto se manca e setta i campi UTM
              // SOLO se vuoti ("prima origine vince"). Prima era un UPDATE
              // separato fire-and-forget che poteva girare PRIMA della INSERT
              // di upsertContact → l'UTM andava perso (race).
              await query(
                `INSERT INTO contacts
                   (site_id, email, utm_source, utm_medium, utm_campaign, utm_term, utm_content, first_source)
                 VALUES ($1, $2, $3::varchar, $4::varchar, $5::varchar, $6::varchar, $7::varchar, COALESCE($3::varchar, ''))
                 ON CONFLICT (site_id, email) DO UPDATE SET
                   utm_source = COALESCE(contacts.utm_source, EXCLUDED.utm_source),
                   utm_medium = COALESCE(contacts.utm_medium, EXCLUDED.utm_medium),
                   utm_campaign = COALESCE(contacts.utm_campaign, EXCLUDED.utm_campaign),
                   utm_term = COALESCE(contacts.utm_term, EXCLUDED.utm_term),
                   utm_content = COALESCE(contacts.utm_content, EXCLUDED.utm_content),
                   first_source = CASE WHEN contacts.first_source = '' THEN EXCLUDED.first_source ELSE contacts.first_source END,
                   updated_at = NOW()`,
                [siteId, email, utm.utm_source, utm.utm_medium, utm.utm_campaign, utm.utm_term, utm.utm_content]
              );
            } catch (err) {
              logger.error(`UTM update fallito (site=${siteId}, ${email}): ${err.message}`);
            }
            await emitContactEvent(siteId, email, "form_submitted", { form_slug: formSlug, utm });
          })();
        }).catch(err => logger.error(`Evento form_submitted fallito (site=${siteId}): ${err.message}`));
      } else {
        import("../services/events.js").then(({ emitContactEvent }) =>
          emitContactEvent(siteId, email, "form_submitted", { form_slug: formSlug })
        ).catch(err => logger.error(`Evento form_submitted fallito (site=${siteId}): ${err.message}`));
      }
    }
    sendMetaCapiEvent(siteId, "Lead", {
      email, eventSourceUrl: req.headers["referer"], clientIp: req.ip,
      userAgent: req.headers["user-agent"], consentGranted: isMarketingConsentGranted(req),
    }).catch(() => {});

    // Redirect post-invio: priorità alla pagina di ringraziamento configurata
    // nel builder (redirect_url), poi al parametro nascosto _redirect del
    // form, poi al referer. Tutti validati con isSafeRedirect: mai un
    // redirect a dominio esterno arbitrario.
    const configuredRedirect = isSafeRedirect(formDef?.redirect_url, req) ? formDef.redirect_url : null;
    const safeRedirect = configuredRedirect || (isSafeRedirect(req.body._redirect, req) ? req.body._redirect : null);
    const safeReferer = isSafeRedirect(req.headers["referer"], req) ? req.headers["referer"] : null;
    const redirectTo = safeRedirect || safeReferer || "/";
    if (isAjaxRequest(req)) {
      return res.json({ ok: true, message: formDef?.success_message || undefined, redirect: configuredRedirect || undefined });
    }
    res.redirect(redirectTo);
  } catch (err) { next(err); }
});

export default router;
