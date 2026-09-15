import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  generateSummary, listSummaries, updateSummary, deleteSummary,
} from "../services/call-summaries.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 33 — Riepilogo IA delle chiamate.
// Dopo una chiamata l'agente genera (o rigenera con force) il riassunto, le
// azioni e il prossimo passo; l'operatore può correggerli a mano e marcarli
// come verificati. Stesso pattern di agent-hitl.js: ogni route verifica
// canAccessSite e passa gli errori a next(err). L'auth (requireAuth +
// requireAgent) è applicata dal router padre — qui NON ripetiamo
// router.use('/api/agent', ...).
// ─────────────────────────────────────────────────────────────────────────

export function registerCallSummariesRoutes(router) {
  // ── Elenco riepiloghi (filtri: status, call_id, limit, offset) ────────

  router.get("/api/agent/sites/:siteId/call-summaries", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const summaries = await listSummaries(siteId, {
        status: req.query.status, call_id: req.query.call_id,
        limit: req.query.limit, offset: req.query.offset,
      });
      res.json({ summaries });
    } catch (err) { next(err); }
  });

  // ── Genera/rigenera il riepilogo di una chiamata ───────────────────────
  // force=true rigenera anche se esiste già; senza force e con riepilogo
  // presente → 409 (niente doppi riepiloghi silenziosi).

  router.post("/api/agent/sites/:siteId/call-summaries/:callId/generate", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await generateSummary(siteId, req.params.callId, {
        force: req.body?.force === true,
      });
      if (result.error) return res.status(404).json({ error: result.error });
      if (result.exists) return res.status(409).json({ error: "Riepilogo già esistente" });
      res.json({ summary: result.row });
    } catch (err) { next(err); }
  });

  // ── Correzione manuale (l'operatore sistema il riepilogo dell'IA) ─────

  router.put("/api/agent/sites/:siteId/call-summaries/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const row = await updateSummary(siteId, req.params.id, {
        summary: req.body?.summary, action_items: req.body?.action_items,
        next_step: req.body?.next_step, status: req.body?.status,
      });
      if (!row) return res.status(404).json({ error: "Riepilogo non trovato" });
      res.json({ summary: row });
    } catch (err) { next(err); }
  });

  // ── Eliminazione ───────────────────────────────────────────────────────

  router.delete("/api/agent/sites/:siteId/call-summaries/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteSummary(siteId, req.params.id);
      if (!deleted) return res.status(404).json({ error: "Riepilogo non trovato" });
      res.json({ deleted: parseInt(req.params.id, 10) });
    } catch (err) { next(err); }
  });
}
