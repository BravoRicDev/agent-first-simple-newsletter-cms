import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { sendCsv } from "../services/csv.js";
import { upsertContact, addContactTag } from "../services/contacts.js";
import { sendMetaCapiEvent, isMarketingConsentGranted } from "../services/tracking.js";
import { logger } from "../services/logger.js";
import { translate } from "../middleware/i18n.js";
import config from "../config.js";

const t = (key, vars) => translate(config.defaultLang, key, vars);

const router = Router();

// ── Sanitizzazione definizioni quiz ─────────────────────────────────────────

function sanitizeSlug(raw) {
  return String(raw || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

// Domande: { key, label, options: [{label, points}] }. Le chiavi sono
// derivate dall'etichetta (come i campi dei form), le opzioni sono coppie
// label/punti. Tutto limitato in lunghezza e numero per evitare payload
// abusivi.
function sanitizeQuestions(raw) {
  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const used = new Set();
  return parsed
    .filter(q => q && typeof q.label === "string" && q.label.trim())
    .slice(0, 30)
    .map((q, i) => {
      const label = q.label.trim().slice(0, 255);
      let key = String(q.key || label)
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100) || `domanda_${i + 1}`;
      let unique = key;
      let n = 2;
      while (used.has(unique)) unique = `${key}_${n++}`;
      used.add(unique);
      const options = Array.isArray(q.options)
        ? q.options
            .filter(o => o && typeof o.label === "string" && o.label.trim())
            .slice(0, 12)
            .map(o => ({
              label: o.label.trim().slice(0, 255),
              points: Number.isFinite(Number(o.points)) ? Number(o.points) : 0,
            }))
        : [];
      return { key: unique, label, options };
    });
}

// Soglie di punteggio: { min, max, title, message, class }. min/max numerici
// (max opzionale = infinito), ordinate per min crescente.
function sanitizeThresholds(raw) {
  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const thresholds = parsed
    .filter(x => x && x.title !== undefined && x.title !== null && String(x.title).trim())
    .slice(0, 20)
    .map(x => ({
      min: Number.isFinite(Number(x.min)) ? Number(x.min) : 0,
      // max null/undefined/stringa vuota = open-ended (fino all'infinito).
      // ATTENZIONE: Number(null) === 0, quindi il check DEVE venire PRIMA
      // della conversione numerica, altrimenti una soglia senza max diventa
      // max:0 e non matcha mai i punteggi positivi.
      max: (x.max === null || x.max === undefined || x.max === "") ? null : (Number.isFinite(Number(x.max)) ? Number(x.max) : null),
      title: String(x.title).trim().slice(0, 255),
      message: String(x.message || "").trim().slice(0, 2000),
      class: ["ok", "warn", "cold"].includes(x.class) ? x.class : "",
    }))
    .sort((a, b) => a.min - b.min);
  return thresholds;
}

// Calcolo server-side del punteggio: fonte di verità. Ogni risposta è
// {key domanda: etichetta opzione}; si sommano i punti delle opzioni
// riconosciute (ignorate quelle sconosciute, mai errore).
function computeQuizScore(questions, answers) {
  let total = 0;
  const byKey = {};
  for (const q of questions) {
    byKey[q.key] = q;
  }
  for (const [key, label] of Object.entries(answers || {})) {
    const q = byKey[key];
    if (!q) continue;
    const opt = (q.options || []).find(o => o.label === label);
    if (opt) total += Number(opt.points) || 0;
  }
  return total;
}

function findQuizThreshold(thresholds, points) {
  return (thresholds || []).find(th =>
    points >= Number(th.min) && (th.max === null || th.max === undefined || points <= Number(th.max))
  ) || null;
}

// Pagina di ringraziamento (redirect_url): path relativo o URL stesso
// dominio, stessa logica dei form.
function isSafeRedirect(target, req) {
  if (!target) return false;
  if (target.startsWith("/") && !target.startsWith("//")) return true;
  try {
    return new URL(target, `${req.protocol}://${req.get("host")}`).host === req.get("host");
  } catch {
    return false;
  }
}

function sanitizeRedirect(raw, req) {
  const value = String(raw || "").trim().slice(0, 500);
  if (!value) return null;
  return isSafeRedirect(value, req) ? value : null;
}

const quizLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: (req, res) => ({ error: res.locals.t("api.forms.tooManyAttempts") }),
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Admin: index ───────────────────────────────────────────────────────────

router.get("/admin/quizzes", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const quizzes = (await query(
      `SELECT q.id, q.slug, q.name, q.enabled, q.updated_at,
              COALESCE(s.total, 0) AS total, s.last_submission
       FROM quizzes q
       LEFT JOIN (
         SELECT quiz_slug, COUNT(*) AS total, MAX(created_at) AS last_submission
         FROM quiz_submissions WHERE site_id = $1 GROUP BY quiz_slug
       ) s ON s.quiz_slug = q.slug
       WHERE q.site_id = $1
       ORDER BY q.updated_at DESC`,
      [siteId]
    )).rows;

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/quizzes/index", { quizzes, site, sites, siteId, isSuperadmin, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.get("/admin/quizzes/new", requireAuth, authorize("forms", "create"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    res.render("admin/quizzes/builder", { quiz: null, siteId, sites, isSuperadmin, error: null });
  } catch (err) { next(err); }
});

router.post("/admin/quizzes", requireAuth, authorize("forms", "create"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const slug = sanitizeSlug(req.body.slug || req.body.name);
    const name = String(req.body.name || "").trim().slice(0, 255);
    const intro = String(req.body.intro || "").trim().slice(0, 2000);
    const questions = sanitizeQuestions(req.body.questions_json);
    const thresholds = sanitizeThresholds(req.body.thresholds_json);
    const submitLabel = String(req.body.submit_label || "").trim().slice(0, 100) || "Calcola il risultato";
    const successMessage = String(req.body.success_message || "").trim().slice(0, 1000);
    const askEmail = req.body.ask_email === "1" || req.body.ask_email === true;
    const contactTag = String(req.body.contact_tag || "").trim().slice(0, 100) || null;
    const redirectUrl = sanitizeRedirect(req.body.redirect_url, req);

    const RESERVED_SLUGS = new Set(["new", "search"]);
    if (!slug || !name || RESERVED_SLUGS.has(slug)) {
      return res.status(400).render("admin/quizzes/builder", {
        quiz: { name, slug, intro, questions, thresholds, submit_label: submitLabel, success_message: successMessage, ask_email: askEmail, contact_tag: contactTag, redirect_url: redirectUrl },
        siteId, sites, isSuperadmin,
        error: RESERVED_SLUGS.has(slug) ? `Lo slug "${slug}" è riservato, scegline un altro.` : "Nome e slug sono obbligatori.",
      });
    }

    try {
      await query(
        `INSERT INTO quizzes (site_id, slug, name, intro, questions, thresholds, submit_label, success_message, ask_email, contact_tag, redirect_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [siteId, slug, name, intro, JSON.stringify(questions), JSON.stringify(thresholds), submitLabel, successMessage, askEmail, contactTag, redirectUrl]
      );
    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).render("admin/quizzes/builder", {
          quiz: { name, slug, intro, questions, thresholds, submit_label: submitLabel, success_message: successMessage, ask_email: askEmail, contact_tag: contactTag, redirect_url: redirectUrl },
          siteId, sites, isSuperadmin, error: `Esiste già un questionario con slug "${slug}" su questo sito.`,
        });
      }
      throw err;
    }

    res.redirect(`/admin/quizzes?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.get("/admin/quizzes/:slug/edit", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const result = await query("SELECT * FROM quizzes WHERE site_id = $1 AND slug = $2", [siteId, req.params.slug]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: "Questionario non trovato" });

    res.render("admin/quizzes/builder", { quiz: result.rows[0], siteId, sites, isSuperadmin, error: null });
  } catch (err) { next(err); }
});

router.post("/admin/quizzes/:slug", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const existing = await query("SELECT id FROM quizzes WHERE site_id = $1 AND slug = $2", [siteId, req.params.slug]);
    if (existing.rows.length === 0) return res.status(404).render("error", { message: "Questionario non trovato" });

    const name = String(req.body.name || "").trim().slice(0, 255);
    const intro = String(req.body.intro || "").trim().slice(0, 2000);
    const questions = sanitizeQuestions(req.body.questions_json);
    const thresholds = sanitizeThresholds(req.body.thresholds_json);
    const submitLabel = String(req.body.submit_label || "").trim().slice(0, 100) || "Calcola il risultato";
    const successMessage = String(req.body.success_message || "").trim().slice(0, 1000);
    const askEmail = req.body.ask_email === "1" || req.body.ask_email === true;
    const contactTag = String(req.body.contact_tag || "").trim().slice(0, 100) || null;
    const redirectUrl = sanitizeRedirect(req.body.redirect_url, req);
    const enabled = req.body.enabled !== "0" && req.body.enabled !== false;

    if (!name) {
      return res.status(400).render("admin/quizzes/builder", {
        quiz: { name, slug: req.params.slug, intro, questions, thresholds, submit_label: submitLabel, success_message: successMessage, ask_email: askEmail, contact_tag: contactTag, redirect_url: redirectUrl, enabled },
        siteId, sites, isSuperadmin, error: "Il nome è obbligatorio.",
      });
    }

    await query(
      `UPDATE quizzes SET name = $1, intro = $2, questions = $3, thresholds = $4,
         submit_label = $5, success_message = $6, ask_email = $7, contact_tag = $8,
         redirect_url = $9, enabled = $10, updated_at = NOW()
       WHERE site_id = $11 AND slug = $12`,
      [name, intro, JSON.stringify(questions), JSON.stringify(thresholds), submitLabel, successMessage, askEmail, contactTag, redirectUrl, enabled, siteId, req.params.slug]
    );

    res.redirect(`/admin/quizzes?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.post("/admin/quizzes/:slug/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const siteId = (req.user.role === "superadmin" && req.body.site_id) ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    // Elimina solo la definizione: i risultati già ricevuti restano (come i
    // form scritti a mano che spariscono dalla UI ma non perdono lo storico).
    await query("DELETE FROM quizzes WHERE site_id = $1 AND slug = $2", [siteId, req.params.slug]);

    res.redirect(`/admin/quizzes?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.get("/admin/quizzes/:slug/submissions", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const submissions = (await query(
      `SELECT created_at, data, total_points, result_title, ip_address, referrer
       FROM quiz_submissions
       WHERE site_id = $1 AND quiz_slug = $2
       ORDER BY created_at DESC LIMIT 500`,
      [siteId, req.params.slug]
    )).rows;

    res.render("admin/quizzes/submissions", { submissions, quizSlug: req.params.slug, siteId });
  } catch (err) { next(err); }
});

router.get("/admin/quizzes/:slug/submissions/export", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const submissions = (await query(
      `SELECT created_at, data, total_points, result_title, ip_address, referrer
       FROM quiz_submissions
       WHERE site_id = $1 AND quiz_slug = $2
       ORDER BY created_at DESC LIMIT 20000`,
      [siteId, req.params.slug]
    )).rows;

    const dataKeys = [...new Set(submissions.flatMap(s => Object.keys(s.data || {})))];
    const columns = [
      { key: "created_at", label: "Data" },
      { key: "total_points", label: "Punteggio" },
      { key: "result_title", label: "Risultato" },
      ...dataKeys.map(k => ({ key: k, label: k })),
      { key: "ip_address", label: "IP" },
      { key: "referrer", label: "Referrer" },
    ];
    const rows = submissions.map(s => ({
      created_at: new Date(s.created_at).toLocaleString("it-IT"),
      total_points: s.total_points,
      result_title: s.result_title,
      ...s.data,
      ip_address: s.ip_address,
      referrer: s.referrer,
    }));

    sendCsv(res, `${req.params.slug}.csv`, columns, rows);
  } catch (err) { next(err); }
});

// ── Public: submit del quiz ────────────────────────────────────────────────

// Una richiesta è AJAX se dichiara content-type JSON, X-Requested-With o
// Accept JSON (stessa logica dei form).
function isAjaxRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json")) return true;
  if (req.headers["x-requested-with"] === "XMLHttpRequest") return true;
  const accept = String(req.headers["accept"] || "").toLowerCase();
  return accept.includes("application/json");
}

router.post("/quiz/:siteId/:quizSlug", quizLimiter, resolveSite, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const quizSlug = req.params.quizSlug;

    const siteResult = await query("SELECT id FROM sites WHERE id = $1", [siteId]);
    if (siteResult.rows.length === 0) {
      return res.status(404).json({ error: res.locals.t("api.forms.notFound") });
    }

    if (req.body._honeypot || req.body.website || req.body.url) {
      return res.json({ ok: true });
    }

    const quiz = (await query(
      `SELECT slug, questions, thresholds, success_message, ask_email, contact_tag, redirect_url, enabled
       FROM quizzes WHERE site_id = $1 AND slug = $2`,
      [siteId, quizSlug]
    )).rows[0];

    // Quiz inesistente o disattivato: stesso 200 finto dell'honeypot per non
    // dare indicazioni utili a un bot.
    if (!quiz || !quiz.enabled) return res.json({ ok: true });

    const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
    const answers = (req.body.answers && typeof req.body.answers === "object") ? req.body.answers : {};
    const totalPoints = computeQuizScore(questions, answers);
    const threshold = findQuizThreshold(Array.isArray(quiz.thresholds) ? quiz.thresholds : [], totalPoints);
    const resultTitle = threshold ? threshold.title : "";

    const email = quiz.ask_email && typeof req.body.email === "string"
      ? String(req.body.email).trim().slice(0, 255)
      : "";

    await query(
      `INSERT INTO quiz_submissions (site_id, quiz_slug, data, total_points, result_title, ip_address, user_agent, referrer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        siteId,
        quizSlug.slice(0, 255),
        JSON.stringify(answers),
        totalPoints,
        resultTitle,
        req.ip,
        (req.headers["user-agent"] || "").slice(0, 500),
        (req.headers["referer"] || "").slice(0, 500),
      ]
    );

    // CRM-lite: se il quiz chiede l'email e l'utente la lascia, crea/aggiorna
    // il contatto e assegna il tag configurato (contact_tag), così il lead
    // entra nel CRM e le sequenze con target_tag corrispondente partono.
    if (email) {
      upsertContact(siteId, email).catch(err => logger.error(`Contatti: upsert da quiz fallito (site=${siteId}, ${email}): ${err.message}`));
      if (quiz.contact_tag) {
        addContactTag(siteId, email, quiz.contact_tag).catch(err => logger.error(`Contatti: tag da quiz fallito (site=${siteId}, ${email}, tag=${quiz.contact_tag}): ${err.message}`));
      }
      // Evento per workflow/scoring/segmenti (es. trigger quiz_completed con
      // min_score → azioni). Fire-and-forget: mai bloccare il submit.
      import("../services/events.js").then(({ emitContactEvent }) =>
        emitContactEvent(siteId, email, "quiz_completed", {
          quiz_slug: quizSlug, points: totalPoints, result: resultTitle,
        })
      ).catch(err => logger.error(`Evento quiz_completed fallito (site=${siteId}): ${err.message}`));
      sendMetaCapiEvent(siteId, "Lead", {
        email, eventSourceUrl: req.headers["referer"], clientIp: req.ip,
        userAgent: req.headers["user-agent"], consentGranted: isMarketingConsentGranted(req),
      }).catch(() => {});
    }

    const configuredRedirect = isSafeRedirect(quiz.redirect_url, req) ? quiz.redirect_url : null;
    const safeReferer = isSafeRedirect(req.headers["referer"], req) ? req.headers["referer"] : null;
    const redirectTo = configuredRedirect || safeReferer || "/";

    if (isAjaxRequest(req)) {
      return res.json({
        ok: true,
        points: totalPoints,
        result: resultTitle,
        message: quiz.success_message || undefined,
        redirect: configuredRedirect || undefined,
      });
    }
    res.redirect(redirectTo);
  } catch (err) { next(err); }
});

export default router;
