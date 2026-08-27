import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";

const router = Router();

const PERIODS = { "7": 7, "30": 30, "90": 90 };

router.get("/admin/analytics", requireAuth, authorize("analytics", "read"), async (req, res, next) => {
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

    const days = PERIODS[req.query.days] || 30;

    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [siteId])).rows[0];

    const totalResult = await query(
      `SELECT COUNT(*) AS total FROM page_views pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.site_id = $1 AND pv.visited_at >= NOW() - ($2 || ' days')::interval`,
      [siteId, days]
    );
    const totalViews = parseInt(totalResult.rows[0].total, 10);

    // Aggregazione nel timezone italiano (coerente con la vista, che formatta
    // le date con toLocaleDateString('it-IT')): senza questo, una visita fatta
    // dopo mezzanotte ora italiana ma ancora nel giorno UTC precedente finiva
    // aggregata sotto il giorno sbagliato rispetto a quanto visualizzato.
    const daily = (await query(
      `SELECT date_trunc('day', pv.visited_at AT TIME ZONE 'Europe/Rome') AS day, COUNT(*) AS views
       FROM page_views pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.site_id = $1 AND pv.visited_at >= NOW() - ($2 || ' days')::interval
       GROUP BY day ORDER BY day`,
      [siteId, days]
    )).rows;
    const maxDaily = daily.reduce((m, d) => Math.max(m, parseInt(d.views, 10)), 0);

    const topPages = (await query(
      `SELECT p.url_path, p.title, COUNT(*) AS views
       FROM page_views pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.site_id = $1 AND pv.visited_at >= NOW() - ($2 || ' days')::interval
       GROUP BY p.id, p.url_path, p.title
       ORDER BY views DESC LIMIT 10`,
      [siteId, days]
    )).rows;

    const topReferrers = (await query(
      `SELECT COALESCE(NULLIF(pv.referrer, ''), '(diretto)') AS referrer, COUNT(*) AS views
       FROM page_views pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.site_id = $1 AND pv.visited_at >= NOW() - ($2 || ' days')::interval
       GROUP BY referrer
       ORDER BY views DESC LIMIT 10`,
      [siteId, days]
    )).rows;

    res.render("admin/analytics/index", {
      site, sites, selectedSiteId: siteId, days, totalViews, daily, maxDaily, topPages, topReferrers,
    });
  } catch (err) { next(err); }
});

export default router;
