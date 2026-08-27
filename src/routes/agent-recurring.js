import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listRecurringTasks, createRecurringTask, updateRecurringTask, deleteRecurringTask,
  listFollowupRules, createFollowupRule, updateFollowupRule, deleteFollowupRule,
  checkFollowups, listFollowupRuns,
} from "../services/recurring.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 27: Task ricorrenti + follow-up intelligente ('aspetta risposta →
// se N giorni senza risposta avvisa'). Stesso pattern di crm-agent.js:
// ogni route verifica canAccessSite e passa gli errori a next(err).
// L'auth (requireAuth + requireAgent) è applicata dal router padre — qui
// NON ripetiamo router.use('/api/agent', requireAuth, requireAgent).
// ─────────────────────────────────────────────────────────────────────────

export function registerRecurringRoutes(router) {
  // ── Task ricorrenti ────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/recurring-tasks", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const recurringTasks = await listRecurringTasks(siteId);
      res.json({ recurring_tasks: recurringTasks });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/recurring-tasks", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const recurringTask = await createRecurringTask(siteId, req.body || {});
      res.json({ recurring_task: recurringTask });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/recurring-tasks/:taskId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const taskId = parseInt(req.params.taskId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const recurringTask = await updateRecurringTask(siteId, taskId, req.body || {});
      if (!recurringTask) return res.status(404).json({ error: "Task ricorrente non trovata" });
      res.json({ recurring_task: recurringTask });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/recurring-tasks/:taskId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const taskId = parseInt(req.params.taskId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteRecurringTask(siteId, taskId);
      if (!deleted) return res.status(404).json({ error: "Task ricorrente non trovata" });
      res.json({ deleted: taskId });
    } catch (err) { next(err); }
  });

  // ── Follow-up rules ────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/followup-rules", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const followupRules = await listFollowupRules(siteId);
      res.json({ followup_rules: followupRules });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/followup-rules", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const followupRule = await createFollowupRule(siteId, req.body || {});
      res.json({ followup_rule: followupRule });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/followup-rules/:ruleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const ruleId = parseInt(req.params.ruleId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const followupRule = await updateFollowupRule(siteId, ruleId, req.body || {});
      if (!followupRule) return res.status(404).json({ error: "Regola follow-up non trovata" });
      res.json({ followup_rule: followupRule });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/followup-rules/:ruleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const ruleId = parseInt(req.params.ruleId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteFollowupRule(siteId, ruleId);
      if (!deleted) return res.status(404).json({ error: "Regola follow-up non trovata" });
      res.json({ deleted: ruleId });
    } catch (err) { next(err); }
  });

  // ── Esecuzione + log ───────────────────────────────────────────────────

  // Esegue subito il tick follow-up per il sito (di norma parte dallo
  // scheduler; questo endpoint permette di forzarlo a caldo).
  router.post("/api/agent/sites/:siteId/followup-check", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await checkFollowups(siteId);
      res.json({ result });
    } catch (err) { next(err); }
  });

  // Log esecuzioni follow-up del sito (filtri: rule_id, email).
  router.get("/api/agent/sites/:siteId/followup-runs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const runs = await listFollowupRuns(siteId, {
        ruleId: req.query.rule_id || null,
        email: req.query.email || null,
        limit: req.query.limit || 100,
      });
      res.json({ runs });
    } catch (err) { next(err); }
  });
}
