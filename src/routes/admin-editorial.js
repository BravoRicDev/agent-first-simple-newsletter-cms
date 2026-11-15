import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { STATUSES, isWorkflowEnabled, effectiveStatus, allowedActions, transition, listQueue, listReviews, mapEditorialError } from "../services/editorial.js";

const router = Router();

async function loadPage(req) {
  const id = /^\d+$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : 0;
  const row = id ? (await query("SELECT * FROM pages WHERE id = $1", [id])).rows[0] : null;
  if (!row || (req.user.role !== "superadmin" && row.site_id !== req.user.site_id)) return null;
  return row;
}

router.get("/admin/pages/:id/editorial/state", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const page = await loadPage(req);
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });
    if (!(await isWorkflowEnabled(page.site_id))) return res.json({ enabled: false });
    return res.json({ enabled: true, status: effectiveStatus(page), allowed_actions: await allowedActions(page, req.user, page.site_id), history: await listReviews(page.site_id, page.id) });
  } catch (err) { return next(err); }
});

router.post("/admin/pages/:id/editorial/:action", requireAuth, authorize("pages", "update"), async (req, res, next) => {
  try {
    const page = await loadPage(req);
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });
    const result = await transition(page.site_id, page.id, req.params.action, req.user, { comment: req.body?.comment, ip: req.ip });
    const wantsJson = req.is("application/json") || /json/.test(String(req.headers.accept || ""));
    if (!wantsJson) return res.redirect(`/admin/pages/${page.id}/edit?editorial=${encodeURIComponent(req.params.action)}`);
    return res.json({ ok: true, status: result.to });
  } catch (err) {
    const m = mapEditorialError(err, res.locals.t);
    if (m) return res.status(m.status).json(m.body);
    return next(err);
  }
});

router.get("/admin/editorial", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const isSuper = req.user.role === "superadmin";
    const siteId = isSuper && /^\d+$/.test(String(req.query.site_id || "")) ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] || null;
    const status = STATUSES.includes(req.query.status) ? req.query.status : "in_review";
    return res.render("admin/editorial/index", { site, selectedSiteId: siteId, items: await listQueue(siteId, { status }), status, statuses: STATUSES, enabled: await isWorkflowEnabled(siteId) });
  } catch (err) { return next(err); }
});

export default router;
