import { Router } from "express";
import rateLimit from "express-rate-limit";
import { resolveSite } from "../middleware/resolve-site.js";
import { getCanonicalBaseUrl } from "../services/urls.js";
import { renderFeed } from "../services/feed.js";

const router = Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests" } });

async function serveFeed(req, res, next, { format, slug }) {
  try {
    if (!req.site?.id) return res.status(404).type("text/plain").send("Not found");
    const baseUrl = await getCanonicalBaseUrl(req.site.id, { req });
    const out = await renderFeed(req.site.id, { format, categorySlug: slug, baseUrl });
    if (!out) return res.status(404).type("text/plain").send("Not found");
    res.setHeader("Content-Type", format === "atom" ? "application/atom+xml; charset=utf-8" : "application/rss+xml; charset=utf-8");
    res.setHeader("ETag", out.etag);
    res.setHeader("Last-Modified", out.lastModified.toUTCString());
    res.setHeader("Cache-Control", "public, max-age=300");
    const inm = req.headers["if-none-match"];
    if (inm) {
      if (inm.split(",").map((s) => s.trim()).includes(out.etag)) return res.status(304).end();
    } else if (req.headers["if-modified-since"]) {
      const ims = new Date(req.headers["if-modified-since"]).getTime();
      if (!Number.isNaN(ims) && Math.floor(out.lastModified.getTime() / 1000) * 1000 <= ims) return res.status(304).end();
    }
    return res.send(out.body);
  } catch (err) { next(err); }
}

router.get("/feed.xml", limiter, resolveSite, (req, res, next) => serveFeed(req, res, next, { format: "rss", slug: null }));
router.get("/atom.xml", limiter, resolveSite, (req, res, next) => serveFeed(req, res, next, { format: "atom", slug: null }));
router.get(/^\/feed\/([a-z0-9]+(?:-[a-z0-9]+)*?)(\.atom)?\.xml$/, limiter, resolveSite, (req, res, next) =>
  serveFeed(req, res, next, { format: req.params[1] ? "atom" : "rss", slug: req.params[0] }));

export default router;
