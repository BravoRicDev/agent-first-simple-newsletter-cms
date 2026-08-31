import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { authorize } from "../middleware/authorize.js";
import { exportPublishedPages } from "../services/static-export.js";
import { logger } from "../services/logger.js";
import { getSiteTrackingConfigMasked, setSiteTrackingConfig } from "../services/tracking.js";
import { getSiteSeoConfig, setSiteSeoConfig } from "../services/site-seo.js";

const router = Router();

router.get("/admin/settings", requireAuth, resolveSite, authorize("settings", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      // Non-superadmin: SOLO il proprio site_id (mai Host header)
      : req.user.site_id;

    const globalSettings = (await query(
      "SELECT key, value FROM settings WHERE site_id IS NULL ORDER BY key"
    )).rows;

    const siteSettings = siteId
      ? (await query("SELECT key, value FROM settings WHERE site_id = $1 ORDER BY key", [siteId])).rows
      : [];

    const sites = req.user.role === "superadmin"
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : [];

    const site = siteId
      ? (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0]
      : null;
    // site_id inesistente passato a mano: prima la pagina rendeva comunque e
    // il POST successivo moriva con violazione FK → 500. Meglio un 404 pulito.
    if (siteId && !site) {
      return res.status(404).render("error", { message: res.locals.t("api.common.siteNotFound") });
    }

    const variables = siteId ? (await query(
      "SELECT id, key, value, description, updated_at FROM site_variables WHERE site_id = $1 ORDER BY key",
      [siteId]
    )).rows : [];

    res.render("admin/settings/index", { globalSettings, siteSettings, sites, site, selectedSiteId: siteId || "", variables });
  } catch (err) { next(err); }
});

// Ritorna il valore di una chiave secret su richiesta (bottone "Mostra"):
// il valore reale NON è più nel DOM della pagina (prima era in data-value,
// leggibile da qualunque XSS residuo o da chi ispeziona il sorgente).
// Solo chiavi che matchano il pattern secret. Richiede settings:update
// (admin/superadmin): NIENTE lettura per i ruoli con solo settings:read
// (es. collaboratore), che altrimenti leggerebbero i token in chiaro
// aggirando il mascheramento del pannello e della GET agent.
router.get("/admin/settings/:key/value", requireAuth, authorize("settings", "update"), async (req, res, next) => {
  try {
    const isSecret = /key|secret|password|token|pass/i.test(req.params.key || "");
    if (!isSecret) return res.status(404).json({ error: "Non trovato" });
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;
    const rows = siteId
      ? (await query("SELECT value FROM settings WHERE key = $1 AND site_id = $2", [req.params.key, siteId])).rows
      : (await query("SELECT value FROM settings WHERE key = $1 AND site_id IS NULL", [req.params.key])).rows;
    if (rows.length === 0) return res.status(404).json({ error: "Non trovato" });
    res.json({ value: rows[0].value });
  } catch (err) { next(err); }
});

router.post("/admin/settings", requireAuth, authorize("settings", "update"), async (req, res, next) => {
  try {
    const { key, value, site_id } = req.body;
    if (!key) return res.status(400).render("error", { message: res.locals.t("api.settings.keyRequired") });

    const siteId = site_id ? parseInt(site_id, 10) : null;

    if (siteId && req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    if (!siteId && req.user.role !== "superadmin") {
      return res.status(403).render("error", { message: res.locals.t("api.settings.onlySuperadminGlobal") });
    }

    if (siteId === null) {
      // UPSERT atomico sull'indice univoco parziale settings_global_key_uidx
      // (db/021): il precedente pattern UPDATE-poi-INSERT non era atomico e
      // permetteva a due richieste concorrenti di creare righe duplicate,
      // dato che UNIQUE(site_id, key) non blocca due site_id NULL uguali.
      await query(
        `INSERT INTO settings (site_id, key, value) VALUES (NULL, $1, $2)
         ON CONFLICT (key) WHERE site_id IS NULL DO UPDATE SET value = $2`,
        [key, value || ""]
      );
    } else {
      await query(
        `INSERT INTO settings (site_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (site_id, key) DO UPDATE SET value = $3`,
        [siteId, key, value || ""]
      );
    }

    const redirect = siteId ? `/admin/settings?site_id=${siteId}` : "/admin/settings";
    res.redirect(redirect);
    if (siteId) exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) { next(err); }
});

router.post("/admin/settings/:key/delete", requireAuth, authorize("settings", "delete"), async (req, res, next) => {
  try {
    const { site_id } = req.body;
    const siteId = site_id ? parseInt(site_id, 10) : null;

    if (siteId && req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    if (!siteId && req.user.role !== "superadmin") {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    await query(
      "DELETE FROM settings WHERE key = $1 AND site_id IS NOT DISTINCT FROM $2",
      [req.params.key, siteId]
    );

    const redirect = siteId ? `/admin/settings?site_id=${siteId}` : "/admin/settings";
    res.redirect(redirect);
  } catch (err) { next(err); }
});

// ── Variabili di sito admin ──────────────────────────────────────────────────

router.post("/admin/settings/variables", requireAuth, authorize("settings", "update"), async (req, res, next) => {
  try {
    const { key, value, description, site_id } = req.body;
    const siteId = parseInt(site_id, 10);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteRequired") });
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id)
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    if (!/^[a-zA-Z0-9_-]+$/.test(key))
      return res.status(400).render("error", { message: res.locals.t("api.variables.invalidKey") });

    // I colori del tema finiscono in :root{} del layout (views/layouts/site.ejs)
    // via <%- → una stringa tipo "red;} body{display:none" sarebbe CSS injection.
    // Consenti solo color CSS sicuri: hex, rgb()/rgba()/hsl()/hsla() numerici, nomi.
    if (key === "primary_color" || key === "secondary_color") {
      const v = String(value || "").trim();
      const safe =
        /^#[0-9a-fA-F]{3,8}$/.test(v) ||
        /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v) ||
        /^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v) ||
        /^(transparent|currentColor|inherit|[a-zA-Z]+)$/.test(v);
      if (!safe)
        return res.status(400).render("error", { message: res.locals.t("api.variables.invalidColor") });
    }

    await query(
      `INSERT INTO site_variables (site_id, key, value, description, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (site_id, key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE(NULLIF(EXCLUDED.description,''), site_variables.description),
           updated_at = NOW()`,
      [siteId, key, value || "", description || ""]
    );
    res.redirect(`/admin/settings?site_id=${siteId}`);
    exportPublishedPages({ siteId }).catch(err => logger.error(`Export statico dopo salvataggio impostazioni fallito (site=${siteId}): ${err.message}`));
  } catch (err) { next(err); }
});

router.post("/admin/settings/variables/:key/delete", requireAuth, authorize("settings", "delete"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.body.site_id, 10);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteRequired") });
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id)
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });

    await query(
      "DELETE FROM site_variables WHERE site_id = $1 AND key = $2",
      [siteId, req.params.key]
    );
    res.redirect(`/admin/settings?site_id=${siteId}`);
    exportPublishedPages({ siteId }).catch(err => logger.error(`Export statico dopo salvataggio impostazioni fallito (site=${siteId}): ${err.message}`));
  } catch (err) { next(err); }
});

// ── Tracking & Analytics ────────────────────────────────────────────────────
// UI dedicata con campi etichettati sopra la stessa tabella "settings"
// generica usata sopra (chiavi tracking_*, vedi services/tracking.js) —
// evita che chi vuole solo incollare un ID GA4 debba sapere il nome esatto
// della chiave da impostare a mano nel form key/value generico.

router.get("/admin/settings/tracking", requireAuth, resolveSite, authorize("settings", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      // Non-superadmin: SOLO il proprio site_id (mai Host header)
      : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const sites = req.user.role === "superadmin" ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const trackingConfig = await getSiteTrackingConfigMasked(siteId);

    res.render("admin/settings/tracking", { site, sites, selectedSiteId: siteId, trackingConfig, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.post("/admin/settings/tracking", requireAuth, authorize("settings", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id
      ? parseInt(req.body.site_id, 10)
      : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const fields = {
      ga4Id: req.body.ga4_id,
      gtmId: req.body.gtm_id,
      metaPixelId: req.body.meta_pixel_id,
      metaCapiTestCode: req.body.meta_capi_test_code,
      clarityId: req.body.clarity_id,
      searchConsoleVerification: req.body.search_console_verification,
      consentBannerText: req.body.consent_banner_text,
      consentAcceptLabel: req.body.consent_accept_label,
      consentRejectLabel: req.body.consent_reject_label,
      consentPrivacyUrl: req.body.consent_privacy_url,
      consentProvider: req.body.consent_provider,
      consentLibUrl: req.body.consent_lib_url,
      consentLibCssUrl: req.body.consent_lib_css_url,
      consentScriptUrl: req.body.consent_script_url,
      leadEventName: req.body.lead_event_name,
      leadPages: req.body.lead_pages,
    };
    // Il token CAPI non viene mai ripresentato in chiaro nel form (solo
    // mascherato): un campo lasciato vuoto significa "non toccarlo", non
    // "cancellalo" — per cancellarlo esplicitamente serve la checkbox dedicata.
    if (req.body.remove_meta_capi_token === "1") {
      fields.metaCapiToken = "";
    } else if (req.body.meta_capi_token) {
      fields.metaCapiToken = req.body.meta_capi_token;
    }

    await setSiteTrackingConfig(siteId, fields);
    res.redirect(`/admin/settings/tracking?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

// ── SEO ──────────────────────────────────────────────────────────────────
// Stesso pattern della sezione Tracking sopra: UI dedicata su misura per i
// campi SEO a livello di sito (immagine OG di default, handle Twitter,
// regole extra per robots.txt), sopra la tabella "settings" generica (chiavi
// seo_*, vedi services/site-seo.js).

router.get("/admin/settings/seo", requireAuth, resolveSite, authorize("settings", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      // Non-superadmin: SOLO il proprio site_id (mai Host header)
      : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const sites = req.user.role === "superadmin" ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const seoConfig = await getSiteSeoConfig(siteId);

    res.render("admin/settings/seo", { site, sites, selectedSiteId: siteId, seoConfig, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.post("/admin/settings/seo", requireAuth, authorize("settings", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id
      ? parseInt(req.body.site_id, 10)
      : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    await setSiteSeoConfig(siteId, {
      defaultOgImage: req.body.default_og_image,
      twitterHandle: req.body.twitter_handle,
      robotsExtra: req.body.robots_extra,
    });
    res.redirect(`/admin/settings/seo?site_id=${siteId}&saved=1`);
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
