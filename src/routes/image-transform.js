import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { parseTransformParams, transformImage } from "../services/image-transform-core.js";
import { setFocalPoint, clearFocalPoint } from "../services/media-focal.js";

const router = Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests" } });

router.get("/img/:siteId/:filename", limiter, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!Number.isInteger(siteId) || siteId < 1 || String(siteId) !== req.params.siteId) return res.status(400).json({ error: "invalid_site" });
    const params = parseTransformParams(req.query, String(req.headers.accept || ""));
    const out = await transformImage(siteId, req.params.filename, params);
    res.setHeader("Content-Type", out.mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (String(req.query.fmt || "auto").toLowerCase() === "auto") res.setHeader("Vary", "Accept");
    res.sendFile(out.file, { dotfiles: "allow" });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.code || "error" });
    next(err);
  }
});

// Focal point da admin (sessione). superadmin puo' indicare site_id, gli altri solo il proprio sito.
router.post("/admin/media/focal", requireAuth, async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).json({ error: res.locals.t("api.common.siteNotSpecified") });
    const filename = String(req.body.filename || "");
    if (req.body.clear === true || req.body.clear === "1") { await clearFocalPoint(siteId, filename); return res.json({ ok: true, focal: null }); }
    const focal = await setFocalPoint(siteId, filename, req.body.x, req.body.y);
    res.json({ ok: true, focal });
  } catch (err) {
    if (err.code === "INVALID_FOCAL") return res.status(400).json({ error: "invalid_focal" });
    if (err.code === "MEDIA_NOT_FOUND") return res.status(404).json({ error: "media_not_found" });
    next(err);
  }
});

export default router;
