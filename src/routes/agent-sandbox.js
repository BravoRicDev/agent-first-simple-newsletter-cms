import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listScenarios, createScenario, updateScenario, deleteScenario,
  runSandbox, listSandboxRuns, getSandboxRun,
} from "../services/sandbox.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 42 — Sandbox/staging.
//
// Dry-run di segmenti, workflow, agenti e preventivi (POST /sandbox/run),
// log delle esecuzioni (GET /sandbox/runs) e scenari riutilizzabili
// (CRUD /sandbox/scenarios). Stesso pattern degli altri moduli agent
// (crm-agent.js, agent-suggestions.js): ogni route verifica canAccessSite
// e passa gli errori a next(err). L'auth (requireAuth + requireAgent) è
// applicata dal router padre — qui NON ripetiamo router.use('/api/agent').
// Le route statiche (/run, /runs) sono registrate PRIMA delle parametriche.
// ─────────────────────────────────────────────────────────────────────────
export function registerSandboxRoutes(router) {
  // ── Scenari riutilizzabili ─────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/sandbox/scenarios", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const scenarios = await listScenarios(siteId, { kind: req.query.kind });
      res.json({ scenarios });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/sandbox/scenarios", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await createScenario(siteId, req.body || {});
      if (result.error) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/sandbox/scenarios/:scenarioId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await updateScenario(siteId, req.params.scenarioId, req.body || {});
      if (result.notFound) return res.status(404).json({ error: "Scenario non trovato" });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/sandbox/scenarios/:scenarioId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteScenario(siteId, req.params.scenarioId);
      if (!deleted) return res.status(404).json({ error: "Scenario non trovato" });
      res.json({ deleted: parseInt(req.params.scenarioId, 10) });
    } catch (err) { next(err); }
  });

  // ── Dry-run ────────────────────────────────────────────────────────────

  router.post("/api/agent/sites/:siteId/sandbox/run", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const { kind, input } = req.body || {};
      const result = await runSandbox({ siteId, kind, input });
      // Kind non valido → errore di validazione (400); gli errori di
      // esecuzione interni arrivano come output.error con status 200.
      if (result.error === "Kind non supportato") return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (err) { next(err); }
  });

  // ── Storico esecuzioni ─────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/sandbox/runs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const runs = await listSandboxRuns(siteId, { kind: req.query.kind, limit: req.query.limit });
      res.json({ runs });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/sandbox/runs/:runId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const run = await getSandboxRun(siteId, req.params.runId);
      if (!run) return res.status(404).json({ error: "Run non trovato" });
      res.json({ run });
    } catch (err) { next(err); }
  });
}
