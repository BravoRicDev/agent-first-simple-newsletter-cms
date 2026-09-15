import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { computeBookingSlots, groupSlotsByDay } from "../services/booking-slots.js";
import { createBooking } from "../services/booking.js";

// ─────────────────────────────────────────────────────────────────────────
// ONDA 2 Phase 3 — Public booking page.
//
// Route pubbliche (nessun auth) per il booking system. I visitatori vedono
// gli slot disponibili e possono prenotare un appuntamento.
//
// Pattern ispirato a /book/:siteId in calls.js ma usa booking_appointments.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

const bookingPublicLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  message: { error: "Troppe richieste. Riprova tra un minuto." },
});

/**
 * Verifica che il sito esista. Se no, risponde 404 e ritorna false.
 */
async function loadSite(siteId, res) {
  const site = (await query(
    "SELECT id, name FROM sites WHERE id = $1",
    [parseInt(siteId, 10)]
  )).rows[0];
  if (!site) {
    res.status(404).render("error", { message: "Sito non trovato", layout: false });
    return null;
  }
  return site;
}

function isAjaxRequest(req) {
  return req.headers["x-requested-with"] === "XMLHttpRequest" ||
    /json/.test(req.get("accept") || "");
}

// ── Slots JSON ──────────────────────────────────────────────────────────

router.get("/booking-public/:siteId/slots", async (req, res, next) => {
  try {
    const site = await loadSite(req.params.siteId, res);
    if (!site) return;
    const days = parseInt(req.query.days, 10) || undefined;
    const slots = await computeBookingSlots(site.id, { days });
    const groups = groupSlotsByDay(slots);
    res.json({ ok: true, groups });
  } catch (err) { next(err); }
});

// ── Pagina di conferma ──────────────────────────────────────────────────

router.get("/booking-public/:siteId/confirmed", async (req, res, next) => {
  try {
    const site = await loadSite(req.params.siteId, res);
    if (!site) return;
    res.render("book/booking-public-confirmed", {
      email: req.query.email || "",
      site,
      layout: false,
    });
  } catch (err) { next(err); }
});

// ── Form booking pubblico ──────────────────────────────────────────────

router.get("/booking-public/:siteId", async (req, res, next) => {
  try {
    const site = await loadSite(req.params.siteId, res);
    if (!site) return;
    const slots = await computeBookingSlots(site.id);
    const groups = groupSlotsByDay(slots);
    res.render("book/booking-public-index", {
      site: { id: site.id, name: site.name, slug: null, description: "" },
      groups,
      error: null,
      layout: false,
    });
  } catch (err) { next(err); }
});

// ── POST: crea prenotazione ────────────────────────────────────────────

router.post("/booking-public/:siteId", bookingPublicLimiter, async (req, res, next) => {
  try {
    const site = await loadSite(req.params.siteId, res);
    if (!site) return;

    // Honeypot anti-spam
    if (req.body._honeypot || req.body.website || req.body.url) {
      if (isAjaxRequest(req)) return res.json({ ok: true });
      return res.redirect(`/booking-public/${site.id}?ok=1`);
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim();
    const startRaw = req.body.slot;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (isAjaxRequest(req)) return res.status(400).json({ error: "Email non valida." });
      const slots = await computeBookingSlots(site.id);
      return res.status(400).render("book/booking-public-index", {
        site: { id: site.id, name: site.name, slug: null, description: "" },
        groups: groupSlotsByDay(slots),
        error: "Email non valida.",
        layout: false,
      });
    }

    if (!name) {
      if (isAjaxRequest(req)) return res.status(400).json({ error: "Nome obbligatorio." });
      const slots = await computeBookingSlots(site.id);
      return res.status(400).render("book/booking-public-index", {
        site: { id: site.id, name: site.name, slug: null, description: "" },
        groups: groupSlotsByDay(slots),
        error: "Nome obbligatorio.",
        layout: false,
      });
    }

    if (!startRaw) {
      if (isAjaxRequest(req)) return res.status(400).json({ error: "Slot non valido." });
      const slots = await computeBookingSlots(site.id);
      return res.status(400).render("book/booking-public-index", {
        site: { id: site.id, name: site.name, slug: null, description: "" },
        groups: groupSlotsByDay(slots),
        error: "Seleziona un orario disponibile.",
        layout: false,
      });
    }

    const startTime = new Date(startRaw);
    if (Number.isNaN(startTime.getTime())) {
      if (isAjaxRequest(req)) return res.status(400).json({ error: "Slot non valido." });
      const slots = await computeBookingSlots(site.id);
      return res.status(400).render("book/booking-public-index", {
        site: { id: site.id, name: site.name, slug: null, description: "" },
        groups: groupSlotsByDay(slots),
        error: "Slot non valido.",
        layout: false,
      });
    }

    // Verifica slot valido tra quelli calcolati ora (DoS protection: client
    // non puo impostare una durata arbitraria)
    const currentSlots = await computeBookingSlots(site.id);
    const matchedSlot = currentSlots.find(s => s.start.getTime() === startTime.getTime());

    if (!matchedSlot) {
      if (isAjaxRequest(req)) return res.status(409).json({ error: "Slot non piu disponibile. Scegline un altro." });
      const slots = await computeBookingSlots(site.id);
      return res.status(409).render("book/booking-public-index", {
        site: { id: site.id, name: site.name, slug: null, description: "" },
        groups: groupSlotsByDay(slots),
        error: "Questo slot non e piu disponibile. Scegline un altro.",
        layout: false,
      });
    }

    // Crea booking
    try {
      const booking = await createBooking(site.id, {
        contact_name: name,
        contact_email: email,
        contact_phone: String(req.body.phone || "").trim(),
        title: `Appuntamento: ${name}`,
        description: "",
        start_time: startTime,
        timezone: "UTC",
      });

      if (isAjaxRequest(req)) {
        return res.json({ ok: true });
      }
      return res.redirect(`/booking-public/${site.id}/confirmed?email=${encodeURIComponent(email)}`);
    } catch (err) {
      // createBooking lancia Error con statusCode
      const statusCode = err.statusCode || 400;
      if (isAjaxRequest(req)) {
        return res.status(statusCode).json({ error: err.message || "Errore durante la prenotazione." });
      }
      const slots = await computeBookingSlots(site.id);
      return res.status(statusCode).render("book/booking-public-index", {
        site: { id: site.id, name: site.name, slug: null, description: "" },
        groups: groupSlotsByDay(slots),
        error: err.message || "Errore durante la prenotazione.",
        layout: false,
      });
    }
  } catch (err) { next(err); }
});

export default router;