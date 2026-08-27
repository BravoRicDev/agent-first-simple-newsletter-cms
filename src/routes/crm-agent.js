import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import { sanitizeSegmentRules, refreshSegmentsForContact, listSegmentMembers, recountSegment, previewSegment } from "../services/segments.js";
import { sanitizeWorkflow, testWorkflow } from "../services/workflows.js";
import { sanitizeScoringRule, sanitizeScoringThreshold } from "../services/scoring.js";
import { listTasks, getTask, createTask, updateTask, deleteTask, getFunnel, buildFunnelSnapshot } from "../services/tasks.js";
import { getPreferences, setPreferences, getOrCreatePrefToken } from "../services/preferences.js";
import { mergeContacts } from "../services/merge.js";
import { getContactEvents } from "../services/events.js";
import { setContactFields, getContactRecord } from "../services/contacts.js";
import { getEmailStatsCampaign, getEmailStatsSequence } from "../services/newsletter-stats.js";
import {
  addContactNote, listContactNotes, deleteContactNote,
  getOrCreateConversation, addConversationMessage, listConversations,
  listConversationMessages, setConversationStatus, deleteConversation,
  CONVERSATION_CHANNELS, CONVERSATION_STATUSES,
} from "../services/conversations.js";
import {
  listOpportunities, getOpportunity, createOpportunity, updateOpportunity, deleteOpportunity,
  listQuotes, getQuote, createQuote, updateQuote, setQuoteStatus, deleteQuote, quoteTotal,
} from "../services/opportunities.js";

// ─────────────────────────────────────────────────────────────────────────
// Route agent CRM (segmenti, workflow, scoring, task, funnel, preferenze,
// merge, pipeline, tracking). Registrate DIRETTAMENTE su agentRouter così
// l'introspezione MCP (discoverTools) le vede automaticamente.
// ─────────────────────────────────────────────────────────────────────────

export function registerCrmRoutes(router) {
  // Auth per TUTTE le route CRM: requireAuth decodifica il Bearer token
  // (JWT o API token) e popola req.user; requireAgent verifica il ruolo.
  router.use("/api/agent", requireAuth, requireAgent);

  // ── F1 Segmenti ────────────────────────────────────────────────────────
  // NB: route statiche PRIMA delle parametriche (:segmentId).

  router.get("/api/agent/sites/:siteId/segments/preview", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      let rules = [];
      if (req.query.rules) {
        try { rules = JSON.parse(req.query.rules); } catch { rules = []; }
      }
      const clean = sanitizeSegmentRules(rules);
      const result = await previewSegment(siteId, clean, req.query.match_mode === "any" ? "any" : "all");
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/segments", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const segments = (await query(
        `SELECT s.*, COUNT(m.email) AS members
         FROM segments s LEFT JOIN segment_members m ON m.segment_id = s.id
         WHERE s.site_id = $1 GROUP BY s.id ORDER BY s.name`,
        [siteId]
      )).rows;
      res.json({ segments });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/segments", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const name = String(req.body.name || "").trim().slice(0, 255);
      if (!name) return res.status(400).json({ error: "Nome obbligatorio" });
      const rules = sanitizeSegmentRules(req.body.rules);
      const matchMode = req.body.match_mode === "any" ? "any" : "all";
      try {
        const result = await query(
          `INSERT INTO segments (site_id, name, description, rules, match_mode)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [siteId, name, String(req.body.description || "").slice(0, 2000), JSON.stringify(rules), matchMode]
        );
        res.json({ segment: result.rows[0] });
      } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Segmento con questo nome già esistente" });
        throw err;
      }
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/segments/:segmentId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const segmentId = parseInt(req.params.segmentId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = (await query("SELECT * FROM segments WHERE id = $1 AND site_id = $2", [segmentId, siteId])).rows[0];
      if (!current) return res.status(404).json({ error: "Segmento non trovato" });
      const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 255) : current.name;
      const rules = req.body.rules !== undefined ? sanitizeSegmentRules(req.body.rules) : current.rules;
      const matchMode = req.body.match_mode !== undefined ? (req.body.match_mode === "any" ? "any" : "all") : current.match_mode;
      const description = req.body.description !== undefined ? String(req.body.description).slice(0, 2000) : current.description;
      const enabled = req.body.enabled !== undefined ? !!req.body.enabled : current.enabled;
      if (!name) return res.status(400).json({ error: "Nome obbligatorio" });
      try {
        await query(
          `UPDATE segments SET name = $1, description = $2, rules = $3, match_mode = $4, enabled = $5, updated_at = NOW()
           WHERE id = $6 AND site_id = $7`,
          [name, description, JSON.stringify(rules), matchMode, enabled, segmentId, siteId]
        );
      } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Segmento con questo nome già esistente" });
        throw err;
      }
      const row = (await query("SELECT * FROM segments WHERE id = $1 AND site_id = $2", [segmentId, siteId])).rows[0];
      res.json({ segment: row });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/segments/:segmentId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const segmentId = parseInt(req.params.segmentId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      await query("DELETE FROM segments WHERE id = $1 AND site_id = $2", [segmentId, siteId]);
      res.json({ deleted: segmentId });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/segments/:segmentId/members", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const segmentId = parseInt(req.params.segmentId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await listSegmentMembers(siteId, segmentId, {
        limit: req.query.limit, offset: req.query.offset,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/segments/:segmentId/recount", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const segmentId = parseInt(req.params.segmentId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await recountSegment(siteId, segmentId);
      res.json(result);
    } catch (err) { next(err); }
  });

  // ── F2 Workflow ────────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/workflows", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const workflows = (await query(
        `SELECT w.*, COUNT(a.id) AS action_count
         FROM workflows w LEFT JOIN workflow_actions a ON a.workflow_id = w.id
         WHERE w.site_id = $1 GROUP BY w.id ORDER BY w.name`,
        [siteId]
      )).rows;
      res.json({ workflows });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/workflows", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const clean = sanitizeWorkflow(req.body);
      if (!clean || !clean.name) return res.status(400).json({ error: "Nome e trigger_type obbligatori" });
      const wfResult = await query(
        `INSERT INTO workflows (site_id, name, active, trigger_type, trigger_config)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [siteId, clean.name, clean.active, clean.trigger_type, JSON.stringify(clean.trigger_config)]
      );
      const workflow = wfResult.rows[0];
      for (const action of clean.actions) {
        await query(
          `INSERT INTO workflow_actions (workflow_id, action_order, action_type, action_config)
           VALUES ($1, $2, $3, $4)`,
          [workflow.id, action.action_order, action.action_type, JSON.stringify(action.action_config)]
        );
      }
      res.json({ workflow: { ...workflow, actions: clean.actions } });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/workflows/:workflowId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const workflowId = parseInt(req.params.workflowId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = (await query("SELECT * FROM workflows WHERE id = $1 AND site_id = $2", [workflowId, siteId])).rows[0];
      if (!current) return res.status(404).json({ error: "Workflow non trovato" });
      const clean = sanitizeWorkflow({ ...req.body, name: req.body.name ?? current.name, trigger_type: req.body.trigger_type ?? current.trigger_type });
      if (!clean) return res.status(400).json({ error: "trigger_type non valido" });
      const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 255) : current.name;
      const active = req.body.active !== undefined ? !!req.body.active : current.active;
      const triggerConfig = req.body.trigger_config !== undefined ? req.body.trigger_config : current.trigger_config;
      await query(
        `UPDATE workflows SET name = $1, active = $2, trigger_config = $3, trigger_type = $4, updated_at = NOW()
         WHERE id = $5 AND site_id = $6`,
        [name, active, JSON.stringify(triggerConfig), clean.trigger_type, workflowId, siteId]
      );
      if (req.body.actions !== undefined) {
        await query("DELETE FROM workflow_actions WHERE workflow_id = $1", [workflowId]);
        for (const action of clean.actions) {
          await query(
            `INSERT INTO workflow_actions (workflow_id, action_order, action_type, action_config)
             VALUES ($1, $2, $3, $4)`,
            [workflowId, action.action_order, action.action_type, JSON.stringify(action.action_config)]
          );
        }
      }
      const row = (await query("SELECT * FROM workflows WHERE id = $1 AND site_id = $2", [workflowId, siteId])).rows[0];
      res.json({ workflow: row });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/workflows/:workflowId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const workflowId = parseInt(req.params.workflowId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      await query("DELETE FROM workflows WHERE id = $1 AND site_id = $2", [workflowId, siteId]);
      res.json({ deleted: workflowId });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/workflows/:workflowId/runs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const workflowId = parseInt(req.params.workflowId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const rows = (await query(
        `SELECT id, email, trigger_type, status, error, created_at FROM workflow_runs
         WHERE workflow_id = $1 AND site_id = $2 ORDER BY created_at DESC LIMIT $3`,
        [workflowId, siteId, limit]
      )).rows;
      res.json({ runs: rows });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/workflows/:workflowId/test", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const workflowId = parseInt(req.params.workflowId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email non valida" });
      const result = await testWorkflow(siteId, workflowId, email);
      res.json(result);
    } catch (err) { next(err); }
  });

  // ── F4 Scoring ─────────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/scoring-rules", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const rules = (await query("SELECT * FROM scoring_rules WHERE site_id = $1 ORDER BY points DESC", [siteId])).rows;
      res.json({ rules });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/scoring-rules", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const clean = sanitizeScoringRule(req.body);
      if (!clean || !clean.name) return res.status(400).json({ error: "Nome e event_type obbligatori" });
      const result = await query(
        `INSERT INTO scoring_rules (site_id, name, event_type, event_filter, points, enabled)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [siteId, clean.name, clean.event_type, JSON.stringify(clean.event_filter), clean.points, clean.enabled]
      );
      res.json({ rule: result.rows[0] });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/scoring-rules/:ruleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const ruleId = parseInt(req.params.ruleId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = (await query("SELECT * FROM scoring_rules WHERE id = $1 AND site_id = $2", [ruleId, siteId])).rows[0];
      if (!current) return res.status(404).json({ error: "Regola non trovata" });
      const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 255) : current.name;
      const points = req.body.points !== undefined ? (Number.isFinite(Number(req.body.points)) ? Number(req.body.points) : current.points) : current.points;
      const enabled = req.body.enabled !== undefined ? !!req.body.enabled : current.enabled;
      const eventFilter = req.body.event_filter !== undefined ? req.body.event_filter : current.event_filter;
      await query(
        `UPDATE scoring_rules SET name = $1, points = $2, enabled = $3, event_filter = $4 WHERE id = $5 AND site_id = $6`,
        [name, points, enabled, JSON.stringify(eventFilter), ruleId, siteId]
      );
      const row = (await query("SELECT * FROM scoring_rules WHERE id = $1 AND site_id = $2", [ruleId, siteId])).rows[0];
      res.json({ rule: row });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/scoring-rules/:ruleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const ruleId = parseInt(req.params.ruleId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      await query("DELETE FROM scoring_rules WHERE id = $1 AND site_id = $2", [ruleId, siteId]);
      res.json({ deleted: ruleId });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/scoring-thresholds", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const thresholds = (await query("SELECT * FROM scoring_thresholds WHERE site_id = $1 ORDER BY min_score", [siteId])).rows;
      res.json({ thresholds });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/scoring-thresholds", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const clean = sanitizeScoringThreshold(req.body);
      if (!clean) return res.status(400).json({ error: "min_score obbligatorio" });
      try {
        const result = await query(
          `INSERT INTO scoring_thresholds (site_id, min_score, action_type, action_config, enabled, trigger_on)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [siteId, clean.min_score, clean.action_type, JSON.stringify(clean.action_config), clean.enabled, clean.trigger_on]
        );
        res.json({ threshold: result.rows[0] });
      } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Soglia per questo min_score già esistente" });
        throw err;
      }
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/scoring-thresholds/:thresholdId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const thresholdId = parseInt(req.params.thresholdId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      await query("DELETE FROM scoring_thresholds WHERE id = $1 AND site_id = $2", [thresholdId, siteId]);
      res.json({ deleted: thresholdId });
    } catch (err) { next(err); }
  });

  // ── F5 Task + Funnel ───────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/tasks", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const tasks = await listTasks(siteId, {
        assigneeId: req.query.assignee_id, status: req.query.status, email: req.query.email,
        limit: req.query.limit, offset: req.query.offset,
      });
      res.json({ tasks });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/tasks", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const title = String(req.body.title || "").trim();
      if (!title) return res.status(400).json({ error: "Titolo obbligatorio" });
      const task = await createTask(siteId, {
        title,
        email: req.body.email,
        assigneeId: req.body.assignee_id,
        dueAt: req.body.due_at,
        notes: req.body.notes,
        createdBy: req.user.sub,
      });
      res.json({ task });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/tasks/:taskId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const taskId = parseInt(req.params.taskId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const task = await updateTask(siteId, taskId, {
        title: req.body.title, email: req.body.email, assigneeId: req.body.assignee_id,
        dueAt: req.body.due_at, notes: req.body.notes, status: req.body.status,
      });
      if (!task) return res.status(404).json({ error: "Task non trovata" });
      res.json({ task });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/tasks/:taskId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const taskId = parseInt(req.params.taskId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      await deleteTask(siteId, taskId);
      res.json({ deleted: taskId });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/funnel", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const rows = await getFunnel(siteId, { from: req.query.from, to: req.query.to });
      res.json({ funnel: rows });
    } catch (err) { next(err); }
  });

  // ── F3 Email stats (open/click) ────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/email-stats/:campaignId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const stats = await getEmailStatsCampaign(siteId, parseInt(req.params.campaignId, 10));
      res.json(stats);
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/email-stats/sequence/:sequenceId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const stats = await getEmailStatsSequence(siteId, parseInt(req.params.sequenceId, 10));
      res.json(stats);
    } catch (err) { next(err); }
  });

  // ── F7 Preferenze (agent) ──────────────────────────────────────────────

  router.post("/api/agent/sites/:siteId/contacts/:email/pref-token", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const email = String(req.params.email || "").trim().toLowerCase();
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email non valida" });
      const token = await getOrCreatePrefToken(siteId, email);
      res.json({ token, url: `/preferences/${token}` });
    } catch (err) { next(err); }
  });

  // ── F8 Merge ───────────────────────────────────────────────────────────

  router.post("/api/agent/sites/:siteId/contacts/:email/merge", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const sourceEmail = String(req.params.email || "").trim().toLowerCase();
      const intoEmail = String(req.body.into_email || "").trim().toLowerCase();
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!intoEmail) return res.status(400).json({ error: "into_email obbligatoria" });
      const result = await mergeContacts(siteId, sourceEmail, intoEmail);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (err) { next(err); }
  });

  // ── F9 Pipeline multiple ───────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/pipelines", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const pipelines = (await query("SELECT * FROM pipelines WHERE site_id = $1 ORDER BY is_default DESC, name", [siteId])).rows;
      res.json({ pipelines });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/pipelines", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const name = String(req.body.name || "").trim().slice(0, 255);
      if (!name) return res.status(400).json({ error: "Nome obbligatorio" });
      const stages = Array.isArray(req.body.stages) ? req.body.stages.slice(0, 20).map((s, i) => ({
        key: String(s.key || `stage_${i + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 50),
        label: String(s.label || s.key || `Stage ${i + 1}`).slice(0, 255),
      })) : [];
      const isDefault = req.body.is_default === true;
      try {
        const result = await query(
          `INSERT INTO pipelines (site_id, name, stages, is_default) VALUES ($1, $2, $3, $4) RETURNING *`,
          [siteId, name, JSON.stringify(stages), isDefault]
        );
        res.json({ pipeline: result.rows[0] });
      } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Pipeline con questo nome già esistente" });
        throw err;
      }
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/pipelines/:pipelineId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const pipelineId = parseInt(req.params.pipelineId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = (await query("SELECT * FROM pipelines WHERE id = $1 AND site_id = $2", [pipelineId, siteId])).rows[0];
      if (!current) return res.status(404).json({ error: "Pipeline non trovata" });
      const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 255) : current.name;
      let stages = current.stages;
      if (req.body.stages !== undefined) {
        stages = Array.isArray(req.body.stages) ? req.body.stages.slice(0, 20).map((s, i) => ({
          key: String(s.key || `stage_${i + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 50),
          label: String(s.label || s.key || `Stage ${i + 1}`).slice(0, 255),
        })) : [];
      }
      const isDefault = req.body.is_default !== undefined ? !!req.body.is_default : current.is_default;
      await query(
        `UPDATE pipelines SET name = $1, stages = $2, is_default = $3 WHERE id = $4 AND site_id = $5`,
        [name, JSON.stringify(stages), isDefault, pipelineId, siteId]
      );
      const row = (await query("SELECT * FROM pipelines WHERE id = $1 AND site_id = $2", [pipelineId, siteId])).rows[0];
      res.json({ pipeline: row });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/pipelines/:pipelineId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const pipelineId = parseInt(req.params.pipelineId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      await query("DELETE FROM pipelines WHERE id = $1 AND site_id = $2", [pipelineId, siteId]);
      res.json({ deleted: pipelineId });
    } catch (err) { next(err); }
  });

  // ── Contact extras: score/utm/preferences/events ───────────────────────

  router.get("/api/agent/sites/:siteId/contacts/:email/extras", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const email = String(req.params.email || "").trim().toLowerCase();
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const record = await getContactRecord(siteId, email);
      const prefs = await getPreferences(siteId, email);
      const events = await getContactEvents(siteId, email, { limit: parseInt(req.query.limit, 10) || 50 });
      res.json({ contact: record, preferences: prefs, events });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/contacts/:email/extras", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const email = String(req.params.email || "").trim().toLowerCase();
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const updates = {};
      if (req.body.add_score !== undefined) {
        const rec = await getContactRecord(siteId, email);
        updates.score = (Number(rec.score) || 0) + (Number(req.body.add_score) || 0);
      }
      if (req.body.score !== undefined) updates.score = Number(req.body.score) || 0;
      if (updates.score !== undefined) {
        await query(
          `UPDATE contacts SET score = $1, score_updated_at = NOW(), updated_at = NOW()
           WHERE site_id = $2 AND email = $3`,
          [updates.score, siteId, email]
        );
      }
      if (req.body.prefs && typeof req.body.prefs === "object") {
        await setPreferences(siteId, email, req.body.prefs);
      }
      if (req.body.utm && typeof req.body.utm === "object") {
        const u = req.body.utm;
        await query(
          `UPDATE contacts SET
             utm_source = COALESCE(utm_source, $1),
             utm_medium = COALESCE(utm_medium, $2),
             utm_campaign = COALESCE(utm_campaign, $3),
             updated_at = NOW()
           WHERE site_id = $4 AND email = $5`,
          [u.utm_source || null, u.utm_medium || null, u.utm_campaign || null, siteId, email]
        );
      }
      const record = await getContactRecord(siteId, email);
      const prefs = await getPreferences(siteId, email);
      res.json({ contact: record, preferences: prefs });
    } catch (err) { next(err); }
  });

  // ── Note lead (timeline) ────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/contacts/:email/notes", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const email = String(req.params.email || "").trim().toLowerCase();
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      res.json({ notes: await listContactNotes(siteId, email) });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/contacts/:email/notes", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const email = String(req.params.email || "").trim().toLowerCase();
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const body = String(req.body.body || "").trim();
      if (!body) return res.status(400).json({ error: "Testo nota obbligatorio" });
      const authorType = ["human", "agent", "system"].includes(req.body.author_type) ? req.body.author_type : "agent";
      const authorName = String(req.body.author_name || "").slice(0, 100);
      const note = await addContactNote(siteId, email, { body, authorType, authorName });
      res.json({ note });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/contacts/:email/notes/:noteId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteContactNote(siteId, req.params.noteId);
      if (!deleted) return res.status(404).json({ error: "Nota non trovata" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });

  // ── Conversazioni (email/WhatsApp) ──────────────────────────────────────

  router.get("/api/agent/sites/:siteId/conversations", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const conversations = await listConversations(siteId, {
        email: req.query.email ? String(req.query.email).trim().toLowerCase() : null,
        channel: req.query.channel || null,
        status: req.query.status || null,
      });
      res.json({ conversations });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/conversations/:conversationId/messages", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await listConversationMessages(siteId, req.params.conversationId);
      if (!result) return res.status(404).json({ error: "Conversazione non trovata" });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/contacts/:email/conversations/:channel/messages", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const email = String(req.params.email || "").trim().toLowerCase();
      const channel = req.params.channel;
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!CONVERSATION_CHANNELS.includes(channel)) return res.status(400).json({ error: "Canale non valido (email|whatsapp)" });
      const body = String(req.body.body || "").trim();
      if (!body) return res.status(400).json({ error: "Testo messaggio obbligatorio" });
      const message = await addConversationMessage(siteId, email, channel, {
        direction: req.body.direction === "in" ? "in" : "out",
        subject: req.body.subject,
        body,
        meta: req.body.meta && typeof req.body.meta === "object" ? req.body.meta : {},
      });
      res.json({ message });
    } catch (err) { next(err); }
  });

  router.patch("/api/agent/sites/:siteId/conversations/:conversationId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = (await query("SELECT * FROM conversations WHERE id = $1 AND site_id = $2", [parseInt(req.params.conversationId, 10), siteId])).rows[0];
      if (!current) return res.status(404).json({ error: "Conversazione non trovata" });
      if (req.body.status !== undefined) {
        if (!CONVERSATION_STATUSES.includes(req.body.status)) return res.status(400).json({ error: "Stato non valido (open|pending|closed)" });
        const updated = await setConversationStatus(siteId, current.id, req.body.status);
        return res.json({ conversation: updated });
      }
      if (req.body.subject !== undefined) {
        await query("UPDATE conversations SET subject = $1, updated_at = NOW() WHERE id = $2", [String(req.body.subject).slice(0, 255), current.id]);
        return res.json({ conversation: (await query("SELECT * FROM conversations WHERE id = $1", [current.id])).rows[0] });
      }
      res.json({ conversation: current });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/conversations/:conversationId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteConversation(siteId, req.params.conversationId);
      if (!deleted) return res.status(404).json({ error: "Conversazione non trovata" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });

  // ── Opportunità/affari ─────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/opportunities", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const opportunities = await listOpportunities(siteId, {
        status: req.query.status || null,
        stage: req.query.stage || null,
        email: req.query.email ? String(req.query.email).trim().toLowerCase() : null,
      });
      res.json({ opportunities });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/opportunities", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const opportunity = await createOpportunity(siteId, {
        email: req.body.email,
        pipeline_id: req.body.pipeline_id,
        stage: req.body.stage,
        title: req.body.title,
        amount: req.body.amount,
        probability: req.body.probability,
        expected_close_at: req.body.expected_close_at,
        notes: req.body.notes,
      });
      if (!opportunity) return res.status(400).json({ error: "Email e titolo obbligatori" });
      res.json({ opportunity });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/opportunities/:opportunityId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const opportunity = await getOpportunity(siteId, req.params.opportunityId);
      if (!opportunity) return res.status(404).json({ error: "Opportunità non trovata" });
      const quotes = await listQuotes(siteId, { opportunity_id: opportunity.id });
      res.json({ opportunity, quotes });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/opportunities/:opportunityId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const opportunity = await updateOpportunity(siteId, req.params.opportunityId, {
        title: req.body.title,
        stage: req.body.stage,
        status: req.body.status,
        amount: req.body.amount,
        probability: req.body.probability,
        pipeline_id: req.body.pipeline_id,
        expected_close_at: req.body.expected_close_at,
        notes: req.body.notes,
      });
      if (!opportunity) return res.status(404).json({ error: "Opportunità non trovata" });
      res.json({ opportunity });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/opportunities/:opportunityId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteOpportunity(siteId, req.params.opportunityId);
      if (!deleted) return res.status(404).json({ error: "Opportunità non trovata" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });

  // ── Preventivi ─────────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/quotes", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const quotes = await listQuotes(siteId, {
        status: req.query.status || null,
        email: req.query.email ? String(req.query.email).trim().toLowerCase() : null,
        opportunity_id: req.query.opportunity_id ? parseInt(req.query.opportunity_id, 10) : null,
      });
      res.json({ quotes });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/quotes", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const quote = await createQuote(siteId, {
        opportunity_id: req.body.opportunity_id,
        contact_email: req.body.email || req.body.contact_email,
        title: req.body.title,
        items: req.body.items,
        notes: req.body.notes,
      });
      if (!quote) return res.status(400).json({ error: "Email obbligatoria" });
      res.json({ quote });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/quotes/:quoteId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const quote = await getQuote(siteId, req.params.quoteId);
      if (!quote) return res.status(404).json({ error: "Preventivo non trovato" });
      res.json({ quote: { ...quote, total: quoteTotal(quote.items) }, public_url: `/quote/${quote.token}` });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/quotes/:quoteId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const quote = await updateQuote(siteId, req.params.quoteId, {
        title: req.body.title,
        items: req.body.items,
        notes: req.body.notes,
        status: req.body.status,
      });
      if (!quote) return res.status(404).json({ error: "Preventivo non trovato" });
      res.json({ quote });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/quotes/:quoteId/status", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const quote = await setQuoteStatus(siteId, req.params.quoteId, req.body.status);
      if (!quote) return res.status(404).json({ error: "Preventivo non trovato o stato non valido" });
      res.json({ quote });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/quotes/:quoteId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteQuote(siteId, req.params.quoteId);
      if (!deleted) return res.status(404).json({ error: "Preventivo non trovato" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });
}
