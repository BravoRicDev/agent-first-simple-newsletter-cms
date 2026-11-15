import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { createRelease, getRelease, listReleases, addItems, removeItem, previewRelease, scheduleRelease, cancelRelease, rebaseRelease, executeRelease, mapReleaseError } from "../services/releases.js";

const router = Router();

function siteOf(req) {
  const isSuper = req.user.role === "superadmin";
  const raw = isSuper ? (req.query.site_id || req.body?.site_id) : null;
  const n = isSuper && /^\d+$/.test(String(raw || "")) ? parseInt(raw, 10) : req.user.site_id;
  return Number.isInteger(n) && n > 0 ? n : null;
}
const idOf = (v) => (/^\d+$/.test(String(v)) ? parseInt(v, 10) : 0);
const back = (siteId, id, kind, code) => `/admin/releases/${id}?site_id=${siteId}&${kind}=${encodeURIComponent(code)}`;

// Esegue un'azione del servizio e rimanda alla pagina di dettaglio con ?msg= / ?err=.
function act(fn, okCode) {
  return async (req, res, next) => {
    const siteId = siteOf(req);
    const id = idOf(req.params.id);
    if (!siteId || !id) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    try {
      await fn({ req, siteId, id });
      return res.redirect(back(siteId, id, "msg", okCode));
    } catch (err) {
      const m = mapReleaseError(err, res.locals.t);
      if (m) return res.redirect(back(siteId, id, "err", m.body.code));
      return next(err);
    }
  };
}

router.get("/admin/releases", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const siteId = siteOf(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    const sites = req.user.role === "superadmin" ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] || null;
    return res.render("admin/releases/index", { site, sites, selectedSiteId: siteId, releases: await listReleases(siteId, {}), query: req.query });
  } catch (err) { return next(err); }
});

router.post("/admin/releases", requireAuth, authorize("pages", "update"), async (req, res, next) => {
  try {
    const siteId = siteOf(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    try {
      const rel = await createRelease(siteId, { name: req.body?.name, description: req.body?.description }, req.user);
      return res.redirect(`/admin/releases/${rel.id}?site_id=${siteId}`);
    } catch (err) {
      const m = mapReleaseError(err, res.locals.t);
      if (m) return res.redirect(`/admin/releases?site_id=${siteId}&err=${encodeURIComponent(m.body.code)}`);
      throw err;
    }
  } catch (err) { return next(err); }
});

router.get("/admin/releases/:id", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const siteId = siteOf(req);
    const id = idOf(req.params.id);
    if (!siteId || !id) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    try {
      const { release } = await getRelease(siteId, id);
      const preview = await previewRelease(siteId, id);
      const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] || null;
      const pages = (await query("SELECT id, url_path, title, published FROM pages WHERE site_id = $1 AND managed_by IS NULL ORDER BY url_path LIMIT 500", [siteId])).rows;
      return res.render("admin/releases/show", { site, selectedSiteId: siteId, release, items: preview.items, preview, pages, query: req.query });
    } catch (err) {
      const m = mapReleaseError(err, res.locals.t);
      if (m) return res.status(m.status).render("error", { message: m.body.message });
      throw err;
    }
  } catch (err) { return next(err); }
});

const W = [requireAuth, authorize("pages", "update")];
router.post("/admin/releases/:id/items", ...W, act(({ req, siteId, id }) => {
  const raw = req.body?.page_ids;
  const pageIds = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0);
  return addItems(siteId, id, pageIds.map((page_id) => ({ page_id, action: req.body?.action })), req.user);
}, "items_added"));
router.post("/admin/releases/:id/items/:pageId/remove", ...W, act(({ req, siteId, id }) => removeItem(siteId, id, idOf(req.params.pageId)), "item_removed"));
router.post("/admin/releases/:id/schedule", ...W, act(({ req, siteId, id }) => scheduleRelease(siteId, id, new Date(req.body?.scheduled_at), req.user), "scheduled"));
router.post("/admin/releases/:id/cancel", ...W, act(({ req, siteId, id }) => cancelRelease(siteId, id, req.user), "cancelled"));
router.post("/admin/releases/:id/rebase", ...W, act(({ req, siteId, id }) => rebaseRelease(siteId, id, req.user), "rebased"));
router.post("/admin/releases/:id/run", ...W, act(async ({ req, siteId, id }) => {
  await getRelease(siteId, id);
  const out = await executeRelease(id, { force: req.body?.force === "1", user: req.user, source: "manual" });
  if (out.skipped) { const e = new Error("INVALID_STATE"); e.code = "INVALID_STATE"; throw e; }
  if (!out.ok && out.conflicts) { const e = new Error("INVALID_STATE"); e.code = "INVALID_STATE"; throw e; }
}, "executed"));

export default router;
