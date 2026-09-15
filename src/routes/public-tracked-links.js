import { Router } from "express";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { resolveSite } from "../middleware/resolve-site.js";
import { registerHit, getTrackedLinkBySlug } from "../services/tracked-links.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 39 — Route pubbliche dei link tracciati (QR / link corto).
//
//   GET /go/:slug          → conta la visita e fa 302 verso target_url.
//                            Se il link non esiste → 404. Se è paused → 404
//                            (non risolve). Se arriva ?email= il visitatore
//                            viene identificato nell'evento.
//   GET /go/:slug.qr       → PNG del QR code del link pubblico (per
//                            stampa/condivisione offline). Serve SOLO se
//                            qr_enabled è true.
//
// NB: la route .qr va dichiarata PRIMA di /go/:slug, altrimenti Express fa
// match /go/:slug anche su /go/:slug.qr (slug = "foo.qr") e la intercetta.
//
// Il sito è risolto dall'hostname via middleware resolveSite (stesso
// pattern di serve.js). Rate limit dedicato (hot path pubblico).
// ─────────────────────────────────────────────────────────────────────────

const goLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

export const publicTrackedLinksRouter = Router();

// PNG QR code del link: /go/:slug.qr (PRIMA di /go/:slug, vedi sopra)
publicTrackedLinksRouter.get("/go/:slug.qr", goLimiter, resolveSite, async (req, res, next) => {
  try {
    const siteId = req.site?.id;
    if (!siteId) return res.status(404).end();

    const slug = String(req.params.slug || "").replace(/\.qr$/i, "");
    const link = await getTrackedLinkBySlug(siteId, slug);
    if (!link || !link.qr_enabled) return res.status(404).end();

    // URL pubblico del link su questo host: il QR deve puntare al path /go/:slug
    // sullo stesso dominio del sito (dove il 302 tracciato è montato).
    const url = `${req.protocol}://${req.get("host")}/go/${encodeURIComponent(link.slug)}`;
    const png = await QRCode.toBuffer(url, { type: "png", width: 320, margin: 1 });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(png);
  } catch (err) {
    next(err);
  }
});

// Redirect tracciato: /go/:slug
publicTrackedLinksRouter.get("/go/:slug", goLimiter, resolveSite, async (req, res, next) => {
  try {
    const siteId = req.site?.id;
    if (!siteId) return res.status(404).end();

    const slug = String(req.params.slug || "").replace(/\.qr$/i, "");

    const email = String(req.query.email || "").trim().toLowerCase().slice(0, 255);
    const referrer = String(req.headers.referer || req.headers.referrer || "").slice(0, 2000);
    const ua = String(req.headers["user-agent"] || "").slice(0, 2000);

    const link = await registerHit(siteId, slug, {
      ip: req.ip || "",
      ua,
      referrer,
      email,
    });

    if (!link) return res.status(404).end();
    res.redirect(302, link.target_url || "/");
  } catch (err) {
    next(err);
  }
});