import { Router } from "express";
import nodemailer from "nodemailer";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { getSiteEmailConfig, resetSiteTransporter } from "../services/email.js";
import { sendTestEmail, renderPreviewHtml, subscribeEmail } from "../services/newsletter.js";
import { sendCsv } from "../services/csv.js";
import { logger } from "../services/logger.js";
import { EMAIL_TEMPLATE_KINDS, listEmailTemplates, setEmailTemplate, deleteEmailTemplate } from "../services/email-templates.js";
import { listTags } from "../services/contacts.js";
import { sendMetaCapiEvent, isMarketingConsentGranted } from "../services/tracking.js";

const router = Router();

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64"
);

function isSafeRedirect(target, req) {
  if (!target) return false;
  if (target.startsWith("/") && !target.startsWith("//")) return true;
  try {
    return new URL(target, `${req.protocol}://${req.get("host")}`).host === req.get("host");
  } catch {
    return false;
  }
}

function respond(req, res, redirectTarget) {
  if (req.headers["content-type"]?.includes("application/json")) {
    return res.json({ ok: true });
  }
  // Anche il Referer come fallback va validato: un utente che arriva da un
  // sito esterno (es. link in una newsletter) verrebbe redirectato lì, open
  // redirect. Se entrambi non sono safe → "/".
  const safeTarget = isSafeRedirect(redirectTarget, req) ? redirectTarget : null;
  const safeReferer = isSafeRedirect(req.headers["referer"], req) ? req.headers["referer"] : null;
  res.redirect(safeTarget || safeReferer || "/");
}

async function resolveAdminSiteId(req) {
  const isSuperadmin = req.user.role === "superadmin";
  const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
  let siteId = isSuperadmin && req.query.site_id
    ? parseInt(req.query.site_id, 10)
    : req.user.site_id;
  if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
  return { isSuperadmin, sites, siteId };
}

function ownsSite(req, siteId) {
  return req.user.role === "superadmin" || siteId === req.user.site_id;
}

// ── Admin ──────────────────────────────────────────────────────────────────

router.get("/admin/newsletter", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { sites, siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const counts = (await query(
      `SELECT status, COUNT(*) AS c FROM newsletter_subscribers WHERE site_id = $1 GROUP BY status`,
      [siteId]
    )).rows;
    const subscriberCounts = { pending: 0, confirmed: 0, unsubscribed: 0 };
    counts.forEach(r => { subscriberCounts[r.status] = parseInt(r.c, 10); });

    const emailConfigured = !!(await getSiteEmailConfig(siteId));

    const campaignCounts = (await query(
      `SELECT status, COUNT(*) AS c FROM newsletter_campaigns WHERE site_id = $1 GROUP BY status`,
      [siteId]
    )).rows;

    res.render("admin/newsletter/index", { site, sites, siteId, subscriberCounts, emailConfigured, campaignCounts });
  } catch (err) { next(err); }
});

// Vista minimale di sola lettura sui post social pianificati/inviati: prima
// di questa route esisteva solo un endpoint per l'agente AI, un admin umano
// non aveva alcun modo di vedere se un post era stato davvero pubblicato o
// solo "simulato" (il posting reale non è implementato, vedi social-poster.js).
router.get("/admin/social", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { sites, siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [siteId])).rows[0];
    const posts = (await query(
      `SELECT sp.*, p.url_path, p.title AS page_title
       FROM social_posts sp
       JOIN pages p ON p.id = sp.page_id
       WHERE p.site_id = $1
       ORDER BY sp.scheduled_at DESC LIMIT 200`,
      [siteId]
    )).rows;

    res.render("admin/social/index", { site, sites, siteId, posts });
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/settings", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { sites, siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const settings = (await query("SELECT * FROM newsletter_settings WHERE site_id = $1", [siteId])).rows[0] || null;
    // La password SMTP NON va mai reinviata nella pagina (prima finiva nel
    // value del campo password, visibile nel sorgente HTML). Stesso pattern
    // del token CAPI: campo vuoto + flag per dire se una password è salvata.
    const smtpPassSet = !!(settings && settings.smtp_pass);
    if (settings) settings.smtp_pass = "";

    res.render("admin/newsletter/settings", { site, sites, siteId, settings, smtpPassSet });
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/settings", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.body.site_id, 10);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteRequired") });
    if (!ownsSite(req, siteId)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const { smtp_host, smtp_port, smtp_user, smtp_pass, from_email, rate_per_hour, signature_html } = req.body;
    if (from_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from_email)) {
      return res.status(400).render("error", { message: res.locals.t("api.newsletter.invalidFromEmail") });
    }
    const port = parseInt(smtp_port, 10) || 465;
    const rate = Math.max(1, parseInt(rate_per_hour, 10) || 100);

    // Password SMTP: il campo parte vuoto (non reinviata al browser). Se
    // lasciato vuoto senza spuntare "rimuovi", mantieni quella esistente;
    // con la checkbox, svuotala.
    let smtpPass = String(smtp_pass || "");
    const removeSmtp = req.body.remove_smtp_pass === "1" || req.body.remove_smtp_pass === "on";
    if (!smtpPass && !removeSmtp) {
      const existing = (await query(
        "SELECT smtp_pass FROM newsletter_settings WHERE site_id = $1",
        [siteId]
      )).rows[0];
      smtpPass = existing?.smtp_pass || "";
    }

    await query(
      `INSERT INTO newsletter_settings (site_id, smtp_host, smtp_port, smtp_user, smtp_pass, from_email, rate_per_hour, signature_html, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (site_id) DO UPDATE SET
         smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port,
         smtp_user = EXCLUDED.smtp_user, smtp_pass = EXCLUDED.smtp_pass,
         from_email = EXCLUDED.from_email, rate_per_hour = EXCLUDED.rate_per_hour,
         signature_html = EXCLUDED.signature_html, updated_at = NOW()`,
      [siteId, smtp_host || "", port, smtp_user || "", smtpPass, from_email || "", rate, signature_html || ""]
    );
    resetSiteTransporter(siteId);

    res.redirect(`/admin/newsletter/settings?site_id=${siteId}`);
  } catch (err) { next(err); }
});

// Email template per sito: override di subject/body per ogni tipo di email
// di sistema (newsletter_confirm, newsletter_test, call_confirmation,
// call_reminder, form_notify, deploy_notify, review_reminder). Se non
// configurato, si usa il default standard. Gestito da UI e API agent.
router.get("/admin/newsletter/email-templates", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { sites, siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const { templates, kinds } = await listEmailTemplates(siteId);
    const byKind = Object.fromEntries(templates.map(t => [t.kind, t]));
    res.render("admin/newsletter/email-templates", { site, sites, siteId, kinds, byKind, EMAIL_TEMPLATE_KINDS });
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/email-templates/:kind", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.body.site_id, 10);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteRequired") });
    if (!ownsSite(req, siteId)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const kind = String(req.params.kind || "");
    if (!EMAIL_TEMPLATE_KINDS.includes(kind)) {
      return res.status(400).render("error", { message: "Tipo di email non supportato" });
    }

    const deleteFlag = req.body.delete === "1" || req.body.delete === "on";
    if (deleteFlag) {
      await deleteEmailTemplate(siteId, kind);
    } else {
      await setEmailTemplate(siteId, kind, {
        subject: req.body.subject,
        body_html: req.body.body_html,
      });
    }
    res.redirect(`/admin/newsletter/email-templates?site_id=${siteId}`);
  } catch (err) { next(err); }
});

// Test connessione SMTP: NON salva nulla. Usa le credenziali inviate dal form
// (che potrebbero non essere ancora state salvate) e, se la password è vuota,
// riusa quella già salvata — stesso comportamento del salvataggio.
router.post("/admin/newsletter/settings/test-smtp", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.body.site_id, 10);
    if (!siteId) return res.status(400).json({ error: res.locals.t("api.common.siteRequired") });
    if (!ownsSite(req, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { smtp_host, smtp_port, smtp_user, smtp_pass, from_email } = req.body;
    const port = parseInt(smtp_port, 10) || 465;

    let smtpPass = String(smtp_pass || "");
    if (!smtpPass) {
      const existing = (await query(
        "SELECT smtp_pass FROM newsletter_settings WHERE site_id = $1",
        [siteId]
      )).rows[0];
      smtpPass = existing?.smtp_pass || "";
    }

    if (!smtp_host || !smtpPass) {
      return res.status(400).json({ error: "Host SMTP e password sono necessari per il test." });
    }

    const testTransporter = nodemailer.createTransport({
      host: smtp_host,
      port,
      secure: port === 465,
      auth: { user: smtp_user || "", pass: smtpPass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });

    await testTransporter.verify();
    res.json({ ok: true, message: `Connessione SMTP riuscita (${smtp_host}:${port}).` });
  } catch (err) {
    res.status(400).json({ error: `Connessione SMTP fallita: ${err.message}` });
  }
});

router.get("/admin/newsletter/subscribers", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { sites, siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const subscribers = (await query(
      `SELECT id, email, status, subscribed_at, confirmed_at, unsubscribed_at
       FROM newsletter_subscribers WHERE site_id = $1 ORDER BY subscribed_at DESC LIMIT 5000`,
      [siteId]
    )).rows;

    res.render("admin/newsletter/subscribers", { site, sites, siteId, subscribers });
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/subscribers/export", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const subscribers = (await query(
      `SELECT email, status, subscribed_at, confirmed_at, unsubscribed_at
       FROM newsletter_subscribers WHERE site_id = $1 ORDER BY subscribed_at DESC LIMIT 20000`,
      [siteId]
    )).rows;

    sendCsv(res, "newsletter-iscritti.csv", [
      { key: "email", label: "Email" },
      { key: "status", label: "Stato" },
      { key: "subscribed_at", label: "Iscritto il" },
      { key: "confirmed_at", label: "Confermato il" },
      { key: "unsubscribed_at", label: "Disiscritto il" },
    ], subscribers);
  } catch (err) { next(err); }
});

// Dettaglio iscritto: cosa gli è stato inviato (broadcast + step di
// sequenza), contenuto sorgente e stato apertura di ciascun invio. NB: il
// contenuto mostrato è quello sorgente della campagna/step (con eventuali
// {{snippet:...}}/{{var:...}} non espansi) — l'HTML finale espanso+firma
// non viene conservato dopo l'invio, solo calcolato al volo.
router.get("/admin/newsletter/subscribers/:id", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const subscriber = (await query("SELECT * FROM newsletter_subscribers WHERE id = $1", [req.params.id])).rows[0];
    if (!subscriber) return res.status(404).render("error", { message: res.locals.t("api.newsletter.subscriberNotFound") });
    if (!ownsSite(req, subscriber.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const sends = (await query(
      `SELECT 'broadcast' AS kind, nc.subject, nc.html_content, ns.sent_at, ns.opened_at, ns.open_count
       FROM newsletter_sends ns JOIN newsletter_campaigns nc ON nc.id = ns.campaign_id
       WHERE ns.subscriber_id = $1
       UNION ALL
       SELECT 'sequence' AS kind, st.subject, st.html_content, nss.sent_at, nss.opened_at, nss.open_count
       FROM newsletter_sequence_sends nss JOIN newsletter_sequence_steps st ON st.id = nss.step_id
       WHERE nss.subscriber_id = $1
       ORDER BY sent_at DESC`,
      [subscriber.id]
    )).rows;

    res.render("admin/newsletter/subscriber-view", { siteId: subscriber.site_id, subscriber, sends });
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/campaigns", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { sites, siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const campaigns = (await query(
      `SELECT c.*, COUNT(s.id) AS sent_count, COUNT(s.opened_at) AS opened_count
       FROM newsletter_campaigns c
       LEFT JOIN newsletter_sends s ON s.campaign_id = c.id
       WHERE c.site_id = $1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [siteId]
    )).rows;

    res.render("admin/newsletter/campaigns", { site, sites, siteId, campaigns });
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/campaigns/new", requireAuth, authorize("newsletter", "create"), async (req, res, next) => {
  try {
    const { siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    const tags = await listTags(siteId);
    res.render("admin/newsletter/campaign-edit", { siteId, campaign: null, tags });
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/campaigns", requireAuth, authorize("newsletter", "create"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.body.site_id, 10);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteRequired") });
    if (!ownsSite(req, siteId)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const { subject, html_content } = req.body;
    if (!subject) return res.status(400).render("error", { message: res.locals.t("api.newsletter.subjectFieldRequired") });
    const targetTag = (req.body.target_tag || "").trim() || null;

    const result = await query(
      `INSERT INTO newsletter_campaigns (site_id, subject, html_content, status, created_by, target_tag)
       VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING id`,
      [siteId, subject, html_content || "", req.user.sub, targetTag]
    );
    res.redirect(`/admin/newsletter/campaigns/${result.rows[0].id}/edit?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/campaigns/:id/edit", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).render("error", { message: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const tags = await listTags(campaign.site_id);
    res.render("admin/newsletter/campaign-edit", { siteId: campaign.site_id, campaign, tags, test_sent: req.query.test_sent });
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/campaigns/:id", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).render("error", { message: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    if (campaign.status !== "draft") return res.status(400).render("error", { message: res.locals.t("api.newsletter.onlyDraftCampaignsEditable") });

    const targetTag = (req.body.target_tag || "").trim() || null;
    await query(
      "UPDATE newsletter_campaigns SET subject = $1, html_content = $2, target_tag = $3 WHERE id = $4",
      [req.body.subject, req.body.html_content || "", targetTag, campaign.id]
    );
    res.redirect(`/admin/newsletter/campaigns/${campaign.id}/edit?site_id=${campaign.site_id}`);
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/campaigns/:id/send", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).render("error", { message: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    if (campaign.status !== "draft") return res.status(400).render("error", { message: res.locals.t("api.newsletter.campaignAlreadyQueued") });

    const emailConfig = await getSiteEmailConfig(campaign.site_id);
    if (!emailConfig) return res.status(400).render("error", { message: res.locals.t("api.newsletter.configureSmtpFirst") });

    await query("UPDATE newsletter_campaigns SET status = 'sending' WHERE id = $1", [campaign.id]);
    res.redirect(`/admin/newsletter/campaigns?site_id=${campaign.site_id}`);
  } catch (err) { next(err); }
});

// Prima non esisteva alcun modo (né UI né API) di fermare una campagna una
// volta avviata: lo scheduler (sendCampaignBatch, ogni 60s) continuava a
// spedire a tutti gli iscritti confermati fino a esaurimento lista, anche se
// l'admin si accorgeva subito di un errore nel contenuto.
router.post("/admin/newsletter/campaigns/:id/pause", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).render("error", { message: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    if (campaign.status !== "sending") return res.status(400).render("error", { message: res.locals.t("api.newsletter.campaignNotSending") });

    await query("UPDATE newsletter_campaigns SET status = 'paused' WHERE id = $1", [campaign.id]);
    res.redirect(`/admin/newsletter/campaigns?site_id=${campaign.site_id}`);
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/campaigns/:id/resume", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).render("error", { message: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    if (campaign.status !== "paused") return res.status(400).render("error", { message: res.locals.t("api.newsletter.campaignNotPaused") });

    await query("UPDATE newsletter_campaigns SET status = 'sending' WHERE id = $1", [campaign.id]);
    res.redirect(`/admin/newsletter/campaigns?site_id=${campaign.site_id}`);
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/campaigns/:id/preview", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).json({ error: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const settings = (await query("SELECT signature_html FROM newsletter_settings WHERE site_id = $1", [campaign.site_id])).rows[0];
    const html = await renderPreviewHtml(campaign.site_id, req.body.html_content || "", settings?.signature_html);
    res.json({ html });
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/campaigns/:id/test-send", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).render("error", { message: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const email = (req.body.email || req.user.email || "").trim();
    if (!email) return res.status(400).render("error", { message: res.locals.t("api.newsletter.emailAddressRequired") });

    const settings = (await query("SELECT signature_html FROM newsletter_settings WHERE site_id = $1", [campaign.site_id])).rows[0];
    if (!settings) return res.status(400).render("error", { message: res.locals.t("api.newsletter.configureSmtpFirst") });

    await sendTestEmail(campaign.site_id, email, campaign.subject, campaign.html_content, settings.signature_html);
    res.redirect(`/admin/newsletter/campaigns/${campaign.id}/edit?site_id=${campaign.site_id}&test_sent=${encodeURIComponent(email)}`);
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/campaigns/:id/recipients", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const campaign = (await query("SELECT * FROM newsletter_campaigns WHERE id = $1", [req.params.id])).rows[0];
    if (!campaign) return res.status(404).render("error", { message: res.locals.t("api.newsletter.campaignNotFound") });
    if (!ownsSite(req, campaign.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const recipients = (await query(
      `SELECT sub.email, ns.sent_at, ns.opened_at, ns.open_count
       FROM newsletter_sends ns JOIN newsletter_subscribers sub ON sub.id = ns.subscriber_id
       WHERE ns.campaign_id = $1 ORDER BY ns.sent_at DESC`,
      [campaign.id]
    )).rows;

    res.render("admin/newsletter/recipients", {
      title: `Destinatari — ${campaign.subject}`,
      backUrl: `/admin/newsletter/campaigns/${campaign.id}/edit?site_id=${campaign.site_id}`,
      siteId: campaign.site_id, recipients,
    });
  } catch (err) { next(err); }
});

// Le sequenze evergreen si creano e si definiscono (step) tramite l'agente
// AI (vedi AGENT.md, sezione NEWSLETTER) — qui solo consultazione e
// attiva/disattiva/elimina, coerente con l'uso del servizio "perlopiù dagli
// agenti".
router.get("/admin/newsletter/sequences", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const { sites, siteId } = await resolveAdminSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const sequences = (await query(
      `SELECT sq.*, COUNT(st.id) AS step_count
       FROM newsletter_sequences sq LEFT JOIN newsletter_sequence_steps st ON st.sequence_id = sq.id
       WHERE sq.site_id = $1 GROUP BY sq.id ORDER BY sq.created_at DESC`,
      [siteId]
    )).rows;

    res.render("admin/newsletter/sequences", { site, sites, siteId, sequences });
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/sequences/:id", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const sequence = (await query("SELECT * FROM newsletter_sequences WHERE id = $1", [req.params.id])).rows[0];
    if (!sequence) return res.status(404).render("error", { message: res.locals.t("api.newsletter.sequenceNotFound") });
    if (!ownsSite(req, sequence.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const steps = (await query(
      `SELECT st.*, COUNT(se.id) AS sent_count, COUNT(se.opened_at) AS opened_count
       FROM newsletter_sequence_steps st LEFT JOIN newsletter_sequence_sends se ON se.step_id = st.id
       WHERE st.sequence_id = $1 GROUP BY st.id ORDER BY st.step_order`,
      [sequence.id]
    )).rows;

    const tags = await listTags(sequence.site_id);
    res.render("admin/newsletter/sequence-view", { siteId: sequence.site_id, sequence, steps, tags, test_sent: req.query.test_sent });
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/sequences/:id/target-tag", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const sequence = (await query("SELECT * FROM newsletter_sequences WHERE id = $1", [req.params.id])).rows[0];
    if (!sequence) return res.status(404).render("error", { message: res.locals.t("api.newsletter.sequenceNotFound") });
    if (!ownsSite(req, sequence.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const targetTag = (req.body.target_tag || "").trim() || null;
    await query("UPDATE newsletter_sequences SET target_tag = $1, updated_at = NOW() WHERE id = $2", [targetTag, sequence.id]);
    res.redirect(`/admin/newsletter/sequences/${sequence.id}?site_id=${sequence.site_id}`);
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/sequences/:id/steps/:stepId/preview", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const sequence = (await query("SELECT * FROM newsletter_sequences WHERE id = $1", [req.params.id])).rows[0];
    if (!sequence) return res.status(404).render("error", { message: res.locals.t("api.newsletter.sequenceNotFound") });
    if (!ownsSite(req, sequence.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const step = (await query("SELECT * FROM newsletter_sequence_steps WHERE id = $1 AND sequence_id = $2", [req.params.stepId, sequence.id])).rows[0];
    if (!step) return res.status(404).render("error", { message: res.locals.t("api.newsletter.stepNotFound") });

    const settings = (await query("SELECT signature_html FROM newsletter_settings WHERE site_id = $1", [sequence.site_id])).rows[0];
    const html = await renderPreviewHtml(sequence.site_id, step.html_content, settings?.signature_html);
    // L'HTML della newsletter è contenuto arbitrario inserito da chi ha
    // permesso newsletter/update: va isolato in un iframe sandboxed (niente
    // script/same-origin) invece di essere servito come pagina piena sotto
    // la sessione autenticata dell'admin — coerente col fatto che nessun
    // client email eseguirebbe comunque script incorporati.
    const safeJson = JSON.stringify(html).replace(/<\/script/gi, "<\\/script");
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;">
<iframe id="f" sandbox style="width:100%;height:100vh;border:0;display:block;"></iframe>
<script>document.getElementById('f').srcdoc = ${safeJson};</script>
</body></html>`);
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/sequences/:id/steps/:stepId/test-send", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const sequence = (await query("SELECT * FROM newsletter_sequences WHERE id = $1", [req.params.id])).rows[0];
    if (!sequence) return res.status(404).render("error", { message: res.locals.t("api.newsletter.sequenceNotFound") });
    if (!ownsSite(req, sequence.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const step = (await query("SELECT * FROM newsletter_sequence_steps WHERE id = $1 AND sequence_id = $2", [req.params.stepId, sequence.id])).rows[0];
    if (!step) return res.status(404).render("error", { message: res.locals.t("api.newsletter.stepNotFound") });

    const email = (req.body.email || req.user.email || "").trim();
    if (!email) return res.status(400).render("error", { message: res.locals.t("api.newsletter.emailAddressRequired") });

    const settings = (await query("SELECT signature_html FROM newsletter_settings WHERE site_id = $1", [sequence.site_id])).rows[0];
    if (!settings) return res.status(400).render("error", { message: res.locals.t("api.newsletter.configureSmtpFirst") });

    await sendTestEmail(sequence.site_id, email, step.subject, step.html_content, settings.signature_html);
    res.redirect(`/admin/newsletter/sequences/${sequence.id}?site_id=${sequence.site_id}&test_sent=${encodeURIComponent(email)}`);
  } catch (err) { next(err); }
});

router.get("/admin/newsletter/sequences/:id/steps/:stepId/recipients", requireAuth, authorize("newsletter", "read"), async (req, res, next) => {
  try {
    const sequence = (await query("SELECT * FROM newsletter_sequences WHERE id = $1", [req.params.id])).rows[0];
    if (!sequence) return res.status(404).render("error", { message: res.locals.t("api.newsletter.sequenceNotFound") });
    if (!ownsSite(req, sequence.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    const step = (await query("SELECT * FROM newsletter_sequence_steps WHERE id = $1 AND sequence_id = $2", [req.params.stepId, sequence.id])).rows[0];
    if (!step) return res.status(404).render("error", { message: res.locals.t("api.newsletter.stepNotFound") });

    const recipients = (await query(
      `SELECT sub.email, se.sent_at, se.opened_at, se.open_count
       FROM newsletter_sequence_sends se JOIN newsletter_subscribers sub ON sub.id = se.subscriber_id
       WHERE se.step_id = $1 ORDER BY se.sent_at DESC`,
      [step.id]
    )).rows;

    res.render("admin/newsletter/recipients", {
      title: `Destinatari — step ${step.step_order}: ${step.subject}`,
      backUrl: `/admin/newsletter/sequences/${sequence.id}?site_id=${sequence.site_id}`,
      siteId: sequence.site_id, recipients,
    });
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/sequences/:id/toggle", requireAuth, authorize("newsletter", "update"), async (req, res, next) => {
  try {
    const sequence = (await query("SELECT * FROM newsletter_sequences WHERE id = $1", [req.params.id])).rows[0];
    if (!sequence) return res.status(404).render("error", { message: res.locals.t("api.newsletter.sequenceNotFound") });
    if (!ownsSite(req, sequence.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    await query("UPDATE newsletter_sequences SET active = NOT active, updated_at = NOW() WHERE id = $1", [sequence.id]);
    res.redirect(`/admin/newsletter/sequences/${sequence.id}?site_id=${sequence.site_id}`);
  } catch (err) { next(err); }
});

router.post("/admin/newsletter/sequences/:id/delete", requireAuth, authorize("newsletter", "delete"), async (req, res, next) => {
  try {
    const sequence = (await query("SELECT * FROM newsletter_sequences WHERE id = $1", [req.params.id])).rows[0];
    if (!sequence) return res.status(404).render("error", { message: res.locals.t("api.newsletter.sequenceNotFound") });
    if (!ownsSite(req, sequence.site_id)) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    await query("DELETE FROM newsletter_sequences WHERE id = $1", [sequence.id]);
    res.redirect(`/admin/newsletter/sequences?site_id=${sequence.site_id}`);
  } catch (err) { next(err); }
});

// ── Public ─────────────────────────────────────────────────────────────────

router.post("/newsletter/:siteId/subscribe", async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);

    // Stesso pattern honeypot dei form pubblici (forms.js).
    if (req.body._honeypot || req.body.website || req.body.url) {
      return respond(req, res, req.body._redirect);
    }

    const email = (req.body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
      return res.status(400).json({ error: res.locals.t("api.common.invalidEmail") });
    }

    const siteResult = await query("SELECT id, name FROM sites WHERE id = $1", [siteId]);
    if (siteResult.rows.length === 0) return res.status(404).json({ error: res.locals.t("api.common.siteNotFound") });

    const emailConfig = await getSiteEmailConfig(siteId);
    if (!emailConfig) return res.status(400).json({ error: res.locals.t("api.newsletter.notAvailableForSite") });

    const result = await subscribeEmail(siteId, email);
    if (result.blocked) {
      // Email bloccata: ritorna un messaggio generico che non rivela il motivo (anti-spam).
      return res.status(400).json({ error: res.locals.t("api.common.invalidEmail") });
    }
    respond(req, res, req.body._redirect);
  } catch (err) { next(err); }
});

router.get("/newsletter/confirm/:token", async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE newsletter_subscribers SET status = 'confirmed', confirmed_at = NOW()
       WHERE token = $1 AND status = 'pending' RETURNING id, site_id, email`,
      [req.params.token]
    );
    if (result.rows.length > 0) {
      const sub = result.rows[0];
      sendMetaCapiEvent(sub.site_id, "CompleteRegistration", {
        email: sub.email, eventSourceUrl: req.headers["referer"], clientIp: req.ip,
        userAgent: req.headers["user-agent"], consentGranted: isMarketingConsentGranted(req),
        dedupKey: sub.id,
      }).catch(() => {});
    }
    res.render("newsletter-confirm", {
      layout: false,
      title: "Iscrizione confermata",
      message: result.rows.length > 0
        ? "Iscrizione confermata. Grazie!"
        : "Link non valido o già usato.",
    });
  } catch (err) { next(err); }
});

router.get("/newsletter/unsubscribe/:token", async (req, res, next) => {
  try {
    // Risposta sempre identica, token valido o no, per non permettere enumerazione.
    // Il token viene azzerato: una volta disiscritto, il vecchio token non deve
    // più funzionare (altrimenti chi lo intercetta può ri-disiscrivere la
    // vittima in qualsiasi momento, anche dopo un re-subscribe).
    await query(
      `UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = NOW(), token = NULL
       WHERE token = $1`,
      [req.params.token]
    );
    res.render("newsletter-confirm", {
      layout: false,
      title: "Disiscrizione",
      message: res.locals.t("api.newsletter.unsubscribedIfWasSubscribed"),
    });
  } catch (err) { next(err); }
});

// kind "c" = campagna broadcast (newsletter_sends), "s" = step di sequenza
// evergreen (newsletter_sequence_sends) — vedi src/services/newsletter.js.
router.get("/newsletter/track/:kind/:trackId/:tokenFile", async (req, res) => {
  const token = req.params.tokenFile.replace(/\.gif$/i, "");
  const trackId = parseInt(req.params.trackId, 10);

  const table = req.params.kind === "s" ? "newsletter_sequence_sends" : "newsletter_sends";
  const column = req.params.kind === "s" ? "step_id" : "campaign_id";

  query(
    `UPDATE ${table} SET opened_at = COALESCE(opened_at, NOW()), open_count = open_count + 1
     WHERE ${column} = $1 AND subscriber_id = (
       SELECT id FROM newsletter_subscribers WHERE token = $2
     )`,
    [trackId, token]
  ).catch(() => {});

  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store" });
  res.send(TRANSPARENT_GIF);
});

export default router;
