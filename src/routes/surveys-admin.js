import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Admin: sondaggi (survey) sincronizzati dal CRM sorgente (source-sync,
// src/services/source-sync/mappers/surveys.js — tabelle surveys/
// survey_submissions). Sola lettura: i sondaggi nascono sul CRM sorgente,
// non nel CMS (a differenza dei "Questionari" nativi in src/routes/
// quizzes.js, tabella `quizzes`, feature distinta e non collegata).
// Prima di questa pagina i dati sincronizzati non erano visibili da
// nessuna parte dell'admin.
// ─────────────────────────────────────────────────────────────────────────

router.get("/admin/surveys", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const surveys = (await query(
      `SELECT s.id, s.name, s.slug, s.status, s.updated_at, s.ghl_id,
              COALESCE(sub.total, 0) AS total, sub.last_submission
       FROM surveys s
       LEFT JOIN (
         SELECT survey_slug, COUNT(*) AS total, MAX(submitted_at) AS last_submission
         FROM survey_submissions WHERE site_id = $1 GROUP BY survey_slug
       ) sub ON sub.survey_slug = s.ghl_id
       WHERE s.site_id = $1
       ORDER BY s.updated_at DESC`,
      [siteId]
    )).rows;

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/surveys/index", { surveys, site, sites, siteId, isSuperadmin });
  } catch (err) { next(err); }
});

router.get("/admin/surveys/:id/submissions", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const survey = (await query(
      "SELECT id, name, slug, ghl_id FROM surveys WHERE id = $1 AND site_id = $2",
      [parseInt(req.params.id, 10), siteId]
    )).rows[0];
    if (!survey) return res.status(404).render("error", { message: "Sondaggio non trovato" });

    const submissions = (await query(
      `SELECT ss.id, ss.data AS answers, ss.submitted_at, c.email AS contact_email
       FROM survey_submissions ss
       LEFT JOIN contacts c ON c.id = ss.contact_id
       WHERE ss.survey_slug = $1 AND ss.site_id = $2
       ORDER BY ss.submitted_at DESC
       LIMIT 500`,
      [survey.ghl_id, siteId]
    )).rows;

    res.render("admin/surveys/submissions", { survey, submissions, siteId });
  } catch (err) { next(err); }
});

export default router;