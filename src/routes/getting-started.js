import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { listEnabledModules } from "../middleware/modules.js";
import { getSiteTrackingConfig } from "../services/tracking.js";
import { MODULES } from "../constants/modules.js";

const router = Router();

// Checklist con stato REALE (interroga il DB), non un elenco statico —
// altrimenti dopo la prima visita perde ogni utilità come promemoria di
// cosa manca ancora. Pensata per chi arriva su un'installazione già
// esistente e non sa cosa sia stato aggiunto nel tempo, tanto quanto per
// chi parte da zero.
router.get("/admin/getting-started", requireAuth, async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];

    if (!siteId) {
      return res.render("admin/getting-started", { siteId: null, sites, site: null, checklist: null, modulesRegistry: MODULES, enabledModules: [] });
    }

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!site) return res.status(404).render("error", { message: res.locals.t("api.common.siteNotFound") });

    const [
      pagesPublished, brandingSet, smtpSet, formsBuilt, trackingConfig,
      apiTokensCount, enabledModules,
    ] = await Promise.all([
      query("SELECT COUNT(*) AS c FROM pages WHERE site_id = $1 AND published = true", [siteId]).then(r => parseInt(r.rows[0].c, 10) > 0),
      query("SELECT 1 FROM site_variables WHERE site_id = $1 AND key = 'brand_name' AND value != ''", [siteId]).then(r => r.rows.length > 0),
      query("SELECT 1 FROM newsletter_settings WHERE site_id = $1 AND smtp_host != ''", [siteId]).then(r => r.rows.length > 0),
      query("SELECT COUNT(*) AS c FROM forms WHERE site_id = $1", [siteId]).then(r => parseInt(r.rows[0].c, 10) > 0),
      getSiteTrackingConfig(siteId),
      query("SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL", [req.user.sub]).then(r => parseInt(r.rows[0].c, 10) > 0),
      listEnabledModules(siteId),
    ]);

    const checklist = [
      { done: pagesPublished, label: "Pubblica almeno una pagina", href: `/admin/pages?site_id=${siteId}` },
      { done: brandingSet, label: "Personalizza nome/logo/colori del sito (branding)", href: `/admin/settings?site_id=${siteId}` },
      { done: smtpSet, label: "Configura l'SMTP per inviare newsletter/email transazionali", href: `/admin/newsletter/settings?site_id=${siteId}` },
      { done: formsBuilt, label: "Crea un form con il form builder", href: `/admin/forms?site_id=${siteId}` },
      { done: trackingConfig.hasAnyTracking, label: "Collega Google Analytics / Meta Pixel / altri strumenti di tracking", href: `/admin/settings/tracking?site_id=${siteId}` },
      { done: apiTokensCount, label: "Genera un token API se vuoi pilotare il sito da n8n o un agente AI", href: "/admin/api-tokens" },
    ];

    res.render("admin/getting-started", { siteId, sites, site, checklist, modulesRegistry: MODULES, enabledModules });
  } catch (err) { next(err); }
});

export default router;
