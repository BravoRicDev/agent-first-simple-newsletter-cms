import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAgent } from "./agent-helpers.js";
import { query } from "../db.js";
import {
  publishEvent, inboxEvents, ackEvent, getEventVisibleTo, EventError,
} from "../services/satelliteEvents.js";
import { findEnabledSatelliteByUserId } from "../services/satellites.js";

// ─────────────────────────────────────────────────────────────────────────
// Eventi asincroni tra satelliti (F2) — polling-only (webhook push differito).
//
//   POST /api/agent/events            publish  { type, target?, payload, dedupeKey? }
//   GET  /api/agent/events/inbox      polling: solo eventi per il proprio satellite
//   POST /api/agent/events/:id/ack    conferma idempotente
//   GET  /api/agent/events            vista generale (solo superadmin)
//
// Il nome del satellite chiamante NON è scelto dal client: è risalito da
// sso_satellites.user_id = utente proprietario dell'agtok_ (binding fatto
// in registrazione). Senza binding → 403 satellite_not_bound.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

async function resolveCallerSatellite(req) {
  if (!req.user?.api_token) return null; // sessioni browser: solo vista superadmin
  return findEnabledSatelliteByUserId(req.user.sub);
}

function requireBoundSatellite(sat) {
  if (!sat) throw new EventError(403, "satellite_not_bound");
}

router.post("/api/agent/events", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const sat = await resolveCallerSatellite(req);
    requireBoundSatellite(sat);
    const body = req.body || {};
    const event = await publishEvent({
      source: sat.name,
      type: body.type,
      target: body.target,
      payload: body.payload,
      dedupeKey: body.dedupeKey ?? body.dedupe_key,
    });
    if (!event) return res.json({ duplicate: true });
    res.status(201).json({ event });
  } catch (err) {
    if (err instanceof EventError) return res.status(err.status).json({ error: err.code });
    next(err);
  }
});

router.get("/api/agent/events/inbox", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const sat = await resolveCallerSatellite(req);
    requireBoundSatellite(sat);
    const events = await inboxEvents({ target: sat.name, limit: req.query.limit });
    res.json({ events });
  } catch (err) {
    if (err && err.message === "satellite_not_bound") {
      return res.status(403).json({ error: "satellite_not_bound" });
    }
    next(err);
  }
});

router.post("/api/agent/events/:id/ack", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const sat = await resolveCallerSatellite(req);
    requireBoundSatellite(sat);
    const acked = await ackEvent({ target: sat.name, id: req.params.id });
    if (acked) return res.json({ event: acked });
    // Idempotente: già acked → 200; inesistente o non visibile → 404.
    const existing = await getEventVisibleTo(sat.name, req.params.id);
    if (existing) return res.json({ event: existing, already_acked: true });
    return res.status(404).json({ error: "event_not_found" });
  } catch (err) {
    if (err && err.message === "satellite_not_bound") {
      return res.status(403).json({ error: "satellite_not_bound" });
    }
    next(err);
  }
});

router.get("/api/agent/events", requireAuth, requireAgent, async (req, res, next) => {
  try {
    if (req.user?.role !== "superadmin") {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }
    const params = [];
    const where = [];
    if (req.query.target) { params.push(String(req.query.target)); where.push(`target = $${params.length}`); }
    if (req.query.status) { params.push(String(req.query.status)); where.push(`status = $${params.length}`); }
    if (req.query.source) { params.push(String(req.query.source)); where.push(`source = $${params.length}`); }
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await query(
      `SELECT * FROM satellite_events ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY created_at DESC LIMIT ${lim}`,
      params
    );
    res.json({ events: rows.rows });
  } catch (err) { next(err); }
});

export default router;
