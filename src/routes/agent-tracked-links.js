import { Router } from "express";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listTrackedLinks,
  getTrackedLink,
  createTrackedLink,
  updateTrackedLink,
  deleteTrackedLink,
  getTrackedLinkStats,
} from "../services/tracked-links.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 39 — Route agent per i link tracciati (QR / link corto).
//
// CRUD per sito + statistiche visite. NIENTE router.use qui: l'auth
// (requireAuth + requireAgent) è applicata dal mount point (stesso pattern
// di agent-payments.js), quindi ogni route richiede requireAgent e verifica
// canAccessSite. L'introspezione MCP (discoverTools) le vede
// automaticamente perché registrate sullo stesso router agent.
// ─────────────────────────────────────────────────────────────────────────

export function registerTrackedLinksRoutes(router) {
  // ── Elenco link (filtro status, paginazione limit/offset) ──────────────
  router.get("/api/agent/sites/:siteId/tracked-links", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const tracked_links = await listTrackedLinks(siteId, {
        status: req.query.status || null,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ tracked_links });
    } catch (err) { next(err); }
  });

  // ── Dettaglio singolo link (con visit_count) ───────────────────────────
  router.get("/api/agent/sites/:siteId/tracked-links/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const tracked_link = await getTrackedLink(siteId, req.params.id);
      if (!tracked_link) return res.status(404).json({ error: "Link tracciato non trovato" });
      res.json({ tracked_link });
    } catch (err) { next(err); }
  });

  // ── Statistiche visite ─────────────────────────────────────────────────
  router.get("/api/agent/sites/:siteId/tracked-links/:id/stats", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const stats = await getTrackedLinkStats(siteId, req.params.id, { days: req.query.days });
      if (!stats) return res.status(404).json({ error: "Link tracciato non trovato" });
      res.json({ stats });
    } catch (err) { next(err); }
  });

  // ── Creazione link ─────────────────────────────────────────────────────
  router.post("/api/agent/sites/:siteId/tracked-links", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const tracked_link = await createTrackedLink(siteId, req.body || {});
      if (!tracked_link) return res.status(400).json({ error: "label e target_url validi obbligatori" });
      res.json({ tracked_link });
    } catch (err) { next(err); }
  });

  // ── Aggiornamento link ─────────────────────────────────────────────────
  router.put("/api/agent/sites/:siteId/tracked-links/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const tracked_link = await updateTrackedLink(siteId, req.params.id, req.body || {});
      if (!tracked_link) return res.status(404).json({ error: "Link tracciato non trovato" });
      res.json({ tracked_link });
    } catch (err) { next(err); }
  });

  // ── Eliminazione link ──────────────────────────────────────────────────
  router.delete("/api/agent/sites/:siteId/tracked-links/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteTrackedLink(siteId, req.params.id);
      if (!deleted) return res.status(404).json({ error: "Link tracciato non trovato" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });
}

// Router autonomo esportato per i test (montato con requireAuth +
// requireAgent su un router locale) e per chi preferisce app.use(...).
export const trackedLinksRouter = Router();
registerTrackedLinksRoutes(trackedLinksRouter);