import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listRuntimes,
  getRuntime,
  createRuntime,
  updateRuntime,
  deleteRuntime,
  processIncomingMessage,
  testRuntime,
} from "../services/agent-runtime.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 29 — Route agent per il runtime conversazionale per canale
// (agent_runtimes): CRUD + process (ingresso messaggio reale) + test
// (dry-run senza side-effect). Registrate su un router passato dal chiamante
// (come registerCrmRoutes): l'auth requireAuth/requireAgent viene applicata
// dal mount (agent.js / test), qui ogni handler verifica canAccessSite.
// ─────────────────────────────────────────────────────────────────────────

const RUNTIME_CHANNELS = ["whatsapp", "email", "chat"];

export function registerAgentRuntimeRoutes(router) {
  // Lista runtimes del sito.
  router.get("/api/agent/sites/:siteId/agent-runtimes", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const runtimes = await listRuntimes(siteId);
      res.json({ runtimes });
    } catch (err) { next(err); }
  });

  // Crea un runtime.
  router.post("/api/agent/sites/:siteId/agent-runtimes", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      try {
        const runtime = await createRuntime(siteId, req.body);
        res.json({ runtime });
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    } catch (err) { next(err); }
  });

  // Aggiorna un runtime (merge parziale).
  router.put("/api/agent/sites/:siteId/agent-runtimes/:runtimeId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const runtimeId = parseInt(req.params.runtimeId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      try {
        const runtime = await updateRuntime(siteId, runtimeId, req.body);
        if (!runtime) return res.status(404).json({ error: "Runtime non trovato" });
        res.json({ runtime });
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    } catch (err) { next(err); }
  });

  // Elimina un runtime.
  router.delete("/api/agent/sites/:siteId/agent-runtimes/:runtimeId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const runtimeId = parseInt(req.params.runtimeId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteRuntime(siteId, runtimeId);
      if (!deleted) return res.status(404).json({ error: "Runtime non trovato" });
      res.json({ deleted: runtimeId });
    } catch (err) { next(err); }
  });

  // Processa un messaggio in ingresso: trova il runtime attivo del canale e
  // (se match contatto + preferenze GDPR ok) scrive la risposta OUT nel
  // registro conversazioni ed esegue le azioni della regola.
  router.post("/api/agent/sites/:siteId/agent-runtime/process", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const channel = String(req.body.channel || "").trim().toLowerCase();
      if (!RUNTIME_CHANNELS.includes(channel)) {
        return res.status(400).json({ error: `channel non valido (attesi: ${RUNTIME_CHANNELS.join(", ")})` });
      }
      if (!req.body.contact_email || !req.body.message) {
        return res.status(400).json({ error: "contact_email e message obbligatori" });
      }
      const result = await processIncomingMessage({
        siteId,
        channel,
        contactEmail: req.body.contact_email,
        message: req.body.message,
        conversationId: req.body.conversation_id,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  // Test dry-run: stessa logica di match/regole ma senza side-effect.
  router.post("/api/agent/sites/:siteId/agent-runtimes/:runtimeId/test", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const runtimeId = parseInt(req.params.runtimeId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await testRuntime(siteId, runtimeId, {
        message: req.body.message,
        contactEmail: req.body.contact_email,
      });
      res.json(result);
    } catch (err) { next(err); }
  });
}
