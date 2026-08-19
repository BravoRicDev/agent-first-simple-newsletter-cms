import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  generateSuggestion, listSuggestions, markUsed, dismissSuggestion, deleteSuggestion,
} from "../services/suggestions.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 34 — Proposta di risposta all'operatore.
// L'agente AI genera una bozza di risposta per una conversazione (contesto
// thread + knowledge base), la salva come 'pending' e l'operatore la
// approva (use) o la scarta (dismiss) con un clic. Stesso pattern degli
// altri moduli agent (crm-agent.js, agent-hitl.js): ogni route verifica
// canAccessSite e passa gli errori a next(err). L'auth (requireAuth +
// requireAgent) è applicata dal router padre — qui NON ripetiamo
// router.use('/api/agent', ...).
// NB: /generate è una route statica e va registrata PRIMA delle
// parametriche (/:id/use, /:id/dismiss).
// ─────────────────────────────────────────────────────────────────────────
export function registerSuggestionsRoutes(router) {
  // ── Generazione proposta ───────────────────────────────────────────────
  router.post("/api/agent/sites/:siteId/reply-suggestions/generate", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const conversationId = parseInt(req.body?.conversation_id, 10);
      if (!Number.isInteger(conversationId) || conversationId < 1) {
        return res.status(400).json({ error: "conversation_id obbligatorio" });
      }
      const suggestion = await generateSuggestion(siteId, conversationId);
      if (suggestion.error) return res.status(404).json({ error: suggestion.error });
      res.json({ suggestion });
    } catch (err) { next(err); }
  });

  // ── Elenco proposte (filtri status/conversation_id, limit/offset) ──────
  router.get("/api/agent/sites/:siteId/reply-suggestions", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const suggestions = await listSuggestions(siteId, {
        status: req.query.status,
        conversation_id: req.query.conversation_id,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ suggestions });
    } catch (err) { next(err); }
  });

  // ── Approvazione con un clic (solo se ancora pending) ──────────────────
  router.post("/api/agent/sites/:siteId/reply-suggestions/:id/use", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await markUsed(siteId, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Suggerimento non trovato" });
      if (result.conflict) return res.status(409).json({ error: "Suggerimento già usato o non più in stato pending", suggestion: result.suggestion });
      res.json({ suggestion: result.suggestion });
    } catch (err) { next(err); }
  });

  // ── Scarto ─────────────────────────────────────────────────────────────
  router.post("/api/agent/sites/:siteId/reply-suggestions/:id/dismiss", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await dismissSuggestion(siteId, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Suggerimento non trovato" });
      res.json({ suggestion: result.suggestion });
    } catch (err) { next(err); }
  });

  // ── Eliminazione ───────────────────────────────────────────────────────
  router.delete("/api/agent/sites/:siteId/reply-suggestions/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteSuggestion(siteId, req.params.id);
      if (!deleted) return res.status(404).json({ error: "Suggerimento non trovato" });
      res.json({ deleted: parseInt(req.params.id, 10) });
    } catch (err) { next(err); }
  });
}
