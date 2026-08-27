import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getContactByPrefToken, setPreferences } from "../services/preferences.js";

const router = Router();

const prefLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// Pagina pubblica centro preferenze: GET /preferences/:token
router.get("/preferences/:token", prefLimiter, async (req, res, next) => {
  try {
    const contact = await getContactByPrefToken(req.params.token);
    if (!contact) {
      return res.status(404).render("preferences", {
        layout: false,
        error: "Link non valido o scaduto.",
        contact: null,
        saved: false,
      });
    }
    res.render("preferences", {
      layout: false,
      token: req.params.token,
      contact,
      error: null,
      saved: false,
    });
  } catch (err) { next(err); }
});

// Aggiorna preferenze: POST /preferences/:token
router.post("/preferences/:token", prefLimiter, async (req, res, next) => {
  try {
    const contact = await getContactByPrefToken(req.params.token);
    if (!contact) {
      return res.status(404).render("preferences", {
        layout: false,
        error: "Link non valido o scaduto.",
        contact: null,
        saved: false,
      });
    }
    const prefs = {
      pref_email: req.body.pref_email === "1" || req.body.pref_email === "on",
      pref_sms: req.body.pref_sms === "1" || req.body.pref_sms === "on",
      pref_phone: req.body.pref_phone === "1" || req.body.pref_phone === "on",
      pref_whatsapp: req.body.pref_whatsapp === "1" || req.body.pref_whatsapp === "on",
      pref_marketing: req.body.pref_marketing === "1" || req.body.pref_marketing === "on",
    };
    const updated = await setPreferences(contact.siteId, contact.email, prefs);
    // Se disattiva il marketing, disiscrivi anche dalla newsletter (coerenza).
    if (!prefs.pref_email || !prefs.pref_marketing) {
      try {
        const { query } = await import("../db.js");
        await query(
          "UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = NOW(), token = NULL WHERE site_id = $1 AND email = $2 AND status = 'confirmed'",
          [contact.siteId, contact.email]
        );
      } catch { /* silenzioso */ }
    }
    res.render("preferences", {
      layout: false,
      token: req.params.token,
      contact: updated,
      error: null,
      saved: true,
    });
  } catch (err) { next(err); }
});

export default router;
