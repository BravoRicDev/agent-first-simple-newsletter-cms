import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listDefinitions,
  getDefinition,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  runSandboxTest,
  listSandboxRuns,
  CHANNELS_WHITELIST,
} from "../services/agent-builder.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 31 — Route agent per l'agent builder visuale + sandbox di test
// (agent_definitions + sandbox_runs): CRUD delle definizioni + test dry-run
// senza side-effect + storico dei test. Registrate su un router passato dal
// chiamante (come registerCrmRoutes): l'auth requireAuth/requireAgent viene
// applicata dal mount (agent.js / test), qui ogni handler verifica
// canAccessSite.
// ─────────────────────────────────────────────────────────────────────────

function handleServiceError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

export function registerAgentBuilderRoutes(router) {
  // Elenco definizioni di agente del sito.
  router.get("/api/agent/sites/:siteId/agent-definitions", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const definitions = await listDefinitions(siteId);
      res.json({ definitions });
    } catch (err) { next(err); }
  });

  // Crea una definizione di agente.
  router.post("/api/agent/sites/:siteId/agent-definitions", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      try {
        const definition = await createDefinition(siteId, req.body);
        res.json({ definition });
      } catch (err) {
        handleServiceError(err, res, next);
      }
    } catch (err) { next(err); }
  });

  // Dettaglio definizione.
  router.get("/api/agent/sites/:siteId/agent-definitions/:defId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const defId = parseInt(req.params.defId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const definition = await getDefinition(siteId, defId);
      if (!definition) return res.status(404).json({ error: "Definizione non trovata" });
      res.json({ definition });
    } catch (err) { next(err); }
  });

  // Aggiorna una definizione (merge parziale).
  router.put("/api/agent/sites/:siteId/agent-definitions/:defId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const defId = parseInt(req.params.defId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      try {
        const definition = await updateDefinition(siteId, defId, req.body);
        if (!definition) return res.status(404).json({ error: "Definizione non trovata" });
        res.json({ definition });
      } catch (err) {
        handleServiceError(err, res, next);
      }
    } catch (err) { next(err); }
  });

  // Elimina una definizione.
  router.delete("/api/agent/sites/:siteId/agent-definitions/:defId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const defId = parseInt(req.params.defId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteDefinition(siteId, defId);
      if (!deleted) return res.status(404).json({ error: "Definizione non trovata" });
      res.json({ deleted: defId });
    } catch (err) { next(err); }
  });

  // Test dry-run in sandbox: genera la risposta simulata senza side-effect
  // (nessuna conversazione/task/tag) e registra la run in sandbox_runs.
  router.post("/api/agent/sites/:siteId/agent-definitions/:defId/test", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const defId = parseInt(req.params.defId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const message = String(req.body.message || "").trim();
      if (!message) return res.status(400).json({ error: "message obbligatorio" });
      const channel = req.body.channel !== undefined && req.body.channel !== null
        ? String(req.body.channel).trim().toLowerCase()
        : null;
      if (channel && !CHANNELS_WHITELIST.includes(channel)) {
        return res.status(400).json({ error: `channel non valido (attesi: ${CHANNELS_WHITELIST.join(", ")})` });
      }
      try {
        const result = await runSandboxTest({
          siteId,
          definitionId: defId,
          message,
          contact_email: req.body.contact_email,
          channel,
        });
        res.json(result);
      } catch (err) {
        handleServiceError(err, res, next);
      }
    } catch (err) { next(err); }
  });

  // Storico dei test sandbox del sito (opzionalmente filtrato per definizione).
  router.get("/api/agent/sites/:siteId/sandbox-runs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const runs = await listSandboxRuns(siteId, {
        limit: req.query.limit,
        definition_id: req.query.definition_id,
      });
      res.json({ runs });
    } catch (err) { next(err); }
  });
}
