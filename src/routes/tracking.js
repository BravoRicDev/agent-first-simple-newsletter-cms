import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { transparentGif, sanitizeClickUrl } from "../services/tracking-email.js";

const router = Router();

// Rate limit dedicato per i pixel/redirect (hot path, bot compresi).
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Click tracking: /track/click/:kind/:sendId?u=<url encoded>
// kind "c" = campagna broadcast, "s" = step di sequenza (stessa convenzione
// del pixel open esistente). Registra l'evento e fa 302 verso l'URL
// (validato: solo http/https, niente javascript:/userinfo/CRLF).
router.get("/track/click/:kind/:sendId", trackLimiter, async (req, res) => {
  const sendId = parseInt(req.params.sendId, 10);
  const kind = req.params.kind === "s" ? "s" : "c";
  const target = sanitizeClickUrl(req.query.u);

  if (Number.isInteger(sendId) && sendId > 0 && target !== "/") {
    try {
      // Risolvi email + site dal send (join con subscriber).
      const table = kind === "s" ? "newsletter_sequence_sends" : "newsletter_sends";
      const row = (await query(
        `SELECT sub.email, sub.site_id FROM ${table} se
         JOIN newsletter_subscribers sub ON sub.id = se.subscriber_id
         WHERE se.id = $1`,
        [sendId]
      )).rows[0];
      if (row) {
        const { recordEmailEvent } = await import("../services/tracking-email.js");
        await recordEmailEvent({
          kind: kind === "s" ? "sequence" : "campaign",
          sendId,
          email: row.email,
          eventType: "click",
          url: target,
          siteId: row.site_id,
        });
      }
    } catch {
      // silenzioso: il tracking non deve mai rompere il redirect
    }
  }

  res.redirect(302, target);
});

// Open tracking (estensione del pixel esistente): risponde 1x1 GIF.
// NB: l'open tracking vero è già gestito da /newsletter/track/:kind/:trackId/
// :tokenFile in routes/newsletter.js — questa route è un alias più semplice
// usato da eventuali test/email; il pixel delle email reali continua a
// puntare alla route esistente (che aggiorna opened_at). Qui rispondiamo
// solo la GIF per compatibilità.
router.get("/track/open/:kind/:sendId", trackLimiter, async (req, res) => {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, max-age=0");
  res.send(transparentGif());
});

export default router;
