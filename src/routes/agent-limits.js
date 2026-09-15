import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listLimits, createLimit, updateLimit, deleteLimit,
  checkLimit, consume, getUsage, resetUsage,
} from "../services/channel-limits.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 44 — Quote/rate-limit per canale con avvisi.
// Limiti (channel_limits) per sito+canale+periodo, verifica (check),
// consumo (consume, incrementa il contatore e avvisa via email al
// superamento) e storico usage. Stesso pattern di agent-reports.js:
// ogni route verifica canAccessSite e passa gli errori a next(err);
// l'auth (requireAuth + requireAgent) è applicata dal router padre —
// qui NON ripetiamo router.use('/api/agent', ...). Gli errori di
// validazione (statusCode 400) e i conflitti UNIQUE (409) lanciati dal
// servizio vengono mappati sulla risposta HTTP corrispondente.
// ─────────────────────────────────────────────────────────────────────────

function parseIntStrict(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function mapServiceError(res, err) {
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  return null;
}

export function registerChannelLimitsRoutes(router) {
  // ── Elenco limiti del sito ─────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/channel-limits", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const limits = await listLimits(siteId);
      res.json({ limits });
    } catch (err) { next(err); }
  });

  // ── Creazione limite ───────────────────────────────────────────────────
  // body: { channel, period?, max_count?, notify_email?, active? }

  router.post("/api/agent/sites/:siteId/channel-limits", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const limit = await createLimit(siteId, req.body || {});
      res.json({ limit });
    } catch (err) {
      const mapped = mapServiceError(res, err);
      if (mapped) return mapped;
      next(err);
    }
  });

  // ── Aggiornamento limite ───────────────────────────────────────────────

  router.put("/api/agent/sites/:siteId/channel-limits/:limitId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const limitId = parseIntStrict(req.params.limitId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!limitId) return res.status(404).json({ error: "Limite non trovato" });
      const limit = await updateLimit(siteId, limitId, req.body || {});
      if (!limit) return res.status(404).json({ error: "Limite non trovato" });
      res.json({ limit });
    } catch (err) {
      const mapped = mapServiceError(res, err);
      if (mapped) return mapped;
      next(err);
    }
  });

  // ── Eliminazione limite ────────────────────────────────────────────────

  router.delete("/api/agent/sites/:siteId/channel-limits/:limitId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const limitId = parseIntStrict(req.params.limitId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!limitId) return res.status(404).json({ error: "Limite non trovato" });
      const deleted = await deleteLimit(siteId, limitId);
      if (!deleted) return res.status(404).json({ error: "Limite non trovato" });
      res.json({ deleted: limitId });
    } catch (err) { next(err); }
  });

  // ── Verifica limite (senza consumare) ──────────────────────────────────
  // body: { channel, period? ('hour'|'day') }
  // → { allowed, usage, limit, remaining, period_start }

  router.post("/api/agent/sites/:siteId/channel-limits/check", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const body = req.body || {};
      const result = await checkLimit(siteId, body.channel, { period: body.period });
      res.json(result);
    } catch (err) {
      const mapped = mapServiceError(res, err);
      if (mapped) return mapped;
      next(err);
    }
  });

  // ── Consumo (incrementa il contatore, avvisa se superato) ──────────────
  // body: { channel, period? ('hour'|'day') }
  // → { allowed, usage, limit, exceeded }

  router.post("/api/agent/sites/:siteId/channel-limits/consume", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const body = req.body || {};
      const result = await consume(siteId, body.channel, { period: body.period });
      res.json(result);
    } catch (err) {
      const mapped = mapServiceError(res, err);
      if (mapped) return mapped;
      next(err);
    }
  });

  // ── Storico usage del canale ───────────────────────────────────────────
  // query: channel (obbligatorio), period? ('hour'|'day', default hour),
  //        limit? (1..100, default 30) → { usage: [{ period_start, count, notified }] }

  router.get("/api/agent/sites/:siteId/channel-usage", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const usage = await getUsage(siteId, req.query.channel, {
        period: req.query.period,
        limit: req.query.limit,
      });
      res.json({ usage });
    } catch (err) {
      const mapped = mapServiceError(res, err);
      if (mapped) return mapped;
      next(err);
    }
  });

  // ── Reset contatore del periodo corrente (manutenzione/test) ───────────
  // body: { channel, period? ('hour'|'day') }
  // → { reset: <righe eliminate>, period_start }

  router.post("/api/agent/sites/:siteId/channel-usage/reset", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const body = req.body || {};
      const result = await resetUsage(siteId, body.channel, { period: body.period });
      res.json(result);
    } catch (err) {
      const mapped = mapServiceError(res, err);
      if (mapped) return mapped;
      next(err);
    }
  });
}
