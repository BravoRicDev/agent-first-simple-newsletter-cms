import { Router } from "express";
import rateLimit from "express-rate-limit";
import { resolveSite } from "../middleware/resolve-site.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { getBlogSetting } from "../services/blog-settings.js";
import { searchPages } from "../services/search.js";

const router = Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests" } });

router.get("/api/public/search", limiter, resolveSite, async (req, res, next) => {
  try {
    if (!req.site?.id) return res.status(404).json({ error: "not_found" });
    if ((await getBlogSetting(req.site.id, "search_enabled")) !== "1") return res.status(404).json({ error: "search_disabled" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2 || q.length > 100) return res.status(400).json({ error: "invalid_query" });
    const out = await searchPages(req.site.id, q, { limit: Math.min(parseInt(req.query.limit, 10) || 10, 20), offset: Math.min(parseInt(req.query.offset, 10) || 0, 200) });
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ q, ...out });
  } catch (err) { next(err); }
});

// Admin (sessione): include bozze. superadmin puo' passare ?site_id=, gli altri solo il proprio sito.
router.get("/admin/api/search", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).json({ error: res.locals.t("api.common.siteNotSpecified") });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const out = await searchPages(siteId, q, { limit: parseInt(req.query.limit, 10) || 20, offset: parseInt(req.query.offset, 10) || 0, includeUnpublished: true });
    res.json({ q, ...out });
  } catch (err) { next(err); }
});

export default router;
