import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { sanitizeSegmentRules } from "../services/segments.js";
import { sanitizeWorkflow } from "../services/workflows.js";
import { sanitizeScoringRule, sanitizeScoringThreshold } from "../services/scoring.js";
import { listTasks, createTask, updateTask, deleteTask, getFunnel } from "../services/tasks.js";
import {
  listOpportunities, getOpportunity, createOpportunity, updateOpportunity, deleteOpportunity,
  listQuotes, createQuote, setQuoteStatus, deleteQuote, quoteTotal,
  getBoard, moveOpportunityStage,
} from "../services/opportunities.js";

const router = Router();

// Redirect "back" sicuro: accetta SOLO path relativi same-origin ("/admin/..."),
// rifiutando scheme ("https://..."), "//evil" e backslash. Previene l'open
// redirect su res.redirect(req.body.back) per phishing fuori dal dominio.
function safeBack(v, fallback) {
  const s = String(v || "").trim();
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("\\") && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return s;
  }
  return fallback;
}

// ── Admin CRM: segmenti, workflow, task, funnel ──────────────────────────
// Viste essenziali: index con tabella + form inline; il grosso dell'uso
// è via API agent/MCP, qui l'accesso rapido per gli umani.

function requireSiteId(req, res) {
  const isSuperadmin = req.user.role === "superadmin";
  const sites = isSuperadmin ? null : null;
  const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
  return siteId;
}

// ── Segmenti ─────────────────────────────────────────────────────────────

router.get("/admin/segments", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const segments = (await query(
      `SELECT s.*, COUNT(m.email) AS members
       FROM segments s LEFT JOIN segment_members m ON m.segment_id = s.id
       WHERE s.site_id = $1 GROUP BY s.id ORDER BY s.name`,
      [siteId]
    )).rows;
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/segments", { segments, site, sites, siteId, isSuperadmin, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.post("/admin/segments", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const name = String(req.body.name || "").trim().slice(0, 255);
    if (name && siteId) {
      let rules = [];
      try { rules = sanitizeSegmentRules(JSON.parse(req.body.rules_json || "[]")); } catch { rules = []; }
      const matchMode = req.body.match_mode === "any" ? "any" : "all";
      await query(
        `INSERT INTO segments (site_id, name, description, rules, match_mode)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (site_id, name) DO UPDATE SET
           rules = EXCLUDED.rules, match_mode = EXCLUDED.match_mode, updated_at = NOW()`,
        [siteId, name, String(req.body.description || "").slice(0, 2000), JSON.stringify(rules), matchMode]
      );
    }
    res.redirect(`/admin/segments?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.post("/admin/segments/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    await query("DELETE FROM segments WHERE id = $1 AND site_id = $2", [parseInt(req.params.id, 10), siteId]);
    res.redirect(`/admin/segments?site_id=${siteId}`);
  } catch (err) { next(err); }
});

// ── Workflow ─────────────────────────────────────────────────────────────

router.get("/admin/workflows", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const workflows = (await query(
      `SELECT w.*, COUNT(a.id) AS action_count
       FROM workflows w LEFT JOIN workflow_actions a ON a.workflow_id = w.id
       WHERE w.site_id = $1 GROUP BY w.id ORDER BY w.name`,
      [siteId]
    )).rows;
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/workflows", { workflows, site, sites, siteId, isSuperadmin, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.post("/admin/workflows", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const clean = sanitizeWorkflow({
      name: req.body.name,
      trigger_type: req.body.trigger_type,
      trigger_config: JSON.parse(req.body.trigger_config_json || "{}"),
      actions: JSON.parse(req.body.actions_json || "[]"),
    });
    if (clean && clean.name && siteId) {
      const result = await query(
        `INSERT INTO workflows (site_id, name, trigger_type, trigger_config)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [siteId, clean.name, clean.trigger_type, JSON.stringify(clean.trigger_config)]
      );
      for (const action of clean.actions) {
        await query(
          `INSERT INTO workflow_actions (workflow_id, action_order, action_type, action_config)
           VALUES ($1, $2, $3, $4)`,
          [result.rows[0].id, action.action_order, action.action_type, JSON.stringify(action.action_config)]
        );
      }
    }
    res.redirect(`/admin/workflows?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.post("/admin/workflows/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    await query("DELETE FROM workflows WHERE id = $1 AND site_id = $2", [parseInt(req.params.id, 10), siteId]);
    res.redirect(`/admin/workflows?site_id=${siteId}`);
  } catch (err) { next(err); }
});

// ── Task ─────────────────────────────────────────────────────────────────

router.get("/admin/tasks", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const tasks = await listTasks(siteId, { status: req.query.status || null, assigneeId: req.query.assignee_id || null });
    const users = (await query("SELECT id, name, email FROM users WHERE site_id = $1 OR role = 'superadmin' ORDER BY name", [siteId])).rows;
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/tasks", { tasks, users, site, sites, siteId, isSuperadmin, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.post("/admin/tasks", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (req.body.title && siteId) {
      await createTask(siteId, {
        title: req.body.title,
        email: req.body.email,
        assigneeId: req.body.assignee_id,
        dueAt: req.body.due_at,
        notes: req.body.notes,
        createdBy: req.user.sub,
      });
    }
    res.redirect(`/admin/tasks?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.post("/admin/tasks/:id/status", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    await updateTask(siteId, parseInt(req.params.id, 10), { status: req.body.status });
    res.redirect(`/admin/tasks?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.post("/admin/tasks/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    await deleteTask(siteId, parseInt(req.params.id, 10));
    res.redirect(`/admin/tasks?site_id=${siteId}`);
  } catch (err) { next(err); }
});

// ── Funnel ───────────────────────────────────────────────────────────────

router.get("/admin/funnel", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const funnel = await getFunnel(siteId, { from: req.query.from, to: req.query.to });
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/funnel", { funnel, site, sites, siteId, isSuperadmin });
  } catch (err) { next(err); }
});

// ── Conversazioni (email/WhatsApp) ───────────────────────────────────────

router.get("/admin/conversations", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const { listConversations, listConversationMessages } = await import("../services/conversations.js");
    const channel = ["email", "whatsapp"].includes(req.query.channel) ? req.query.channel : null;
    const status = ["open", "pending", "closed"].includes(req.query.status) ? req.query.status : null;

    const conversations = await listConversations(siteId, { channel, status });
    // Messaggi del primo thread aperto in vista (per rispondere senza cambiare pagina).
    let thread = null;
    if (req.query.thread) {
      thread = await listConversationMessages(siteId, req.query.thread);
    } else if (conversations.length > 0) {
      thread = await listConversationMessages(siteId, conversations[0].id);
    }

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/conversations", { conversations, thread, site, sites, siteId, isSuperadmin, channel, status });
  } catch (err) { next(err); }
});

router.post("/admin/conversations/:id/messages", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const { addConversationMessage } = await import("../services/conversations.js");
    const conversation = (await query("SELECT * FROM conversations WHERE id = $1 AND site_id = $2", [parseInt(req.params.id, 10), siteId])).rows[0];
    if (!conversation) return res.status(404).render("error", { message: "Conversazione non trovata" });

    const body = String(req.body.body || "").trim();
    if (body) {
      await addConversationMessage(siteId, conversation.contact_email, conversation.channel, {
        direction: req.body.direction === "in" ? "in" : "out",
        subject: req.body.subject || conversation.subject,
        body,
        meta: { admin_user: req.user.email || "" },
      });
    }
    res.redirect(`/admin/conversations?site_id=${siteId}&thread=${conversation.id}`);
  } catch (err) { next(err); }
});

router.post("/admin/conversations/:id/status", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const { setConversationStatus } = await import("../services/conversations.js");
    if (["open", "pending", "closed"].includes(req.body.status)) {
      await setConversationStatus(siteId, parseInt(req.params.id, 10), req.body.status);
    }
    res.redirect(`/admin/conversations?site_id=${siteId}&thread=${req.params.id}`);
  } catch (err) { next(err); }
});

router.post("/admin/conversations/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const { deleteConversation } = await import("../services/conversations.js");
    await deleteConversation(siteId, parseInt(req.params.id, 10));
    res.redirect(`/admin/conversations?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.get("/admin/opportunities/board", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const pipelineId = req.query.pipeline_id ? parseInt(req.query.pipeline_id, 10) : null;
    const { pipelines, currentPipeline, board, stages } = await getBoard(siteId, { pipelineId });
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/board", { pipelines, currentPipeline, board, stages, site, sites, siteId, isSuperadmin });
  } catch (err) { next(err); }
});

// Sposta un'opportunità in uno stage (drag&drop della board).
router.post("/api/opportunities/:id/move", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const updated = await moveOpportunityStage(siteId, req.params.id, {
      stage: req.body.stage,
      pipeline_id: req.body.pipeline_id,
    });
    if (!updated) return res.status(404).json({ ok: false, error: "opportunità non trovata" });
    res.json({ ok: true, stage: updated.stage, status: updated.status });
  } catch (err) { next(err); }
});

// Aggiunge una nota alla timeline del contatto dell'opportunità.
router.post("/api/opportunities/:id/note", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const opportunity = await getOpportunity(siteId, req.params.id);
    if (!opportunity) return res.status(404).json({ ok: false, error: "opportunità non trovata" });

    const body = String(req.body.body || "").trim();
    if (!body) return res.status(400).json({ ok: false, error: "nota vuota" });
    const { addContactNote } = await import("../services/conversations.js");
    const note = await addContactNote(siteId, opportunity.contact_email, {
      body,
      authorType: "human",
      authorName: req.user.name || req.user.email || "",
    });
    // aggiorna updated_at della opportunità così la card torna in cima
    await moveOpportunityStage(siteId, opportunity.id, { stage: opportunity.stage });
    res.json({ ok: true, note: { id: note.id, body: note.body, author_name: note.author_name, created_at: note.created_at } });
  } catch (err) { next(err); }
});

// Timeline note del contatto dell'opportunità (pannello inline nella card).
router.get("/api/opportunities/:id/notes", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    const opportunity = await getOpportunity(siteId, req.params.id);
    if (!opportunity) return res.status(404).json({ ok: false, error: "opportunità non trovata" });
    const { listContactNotes } = await import("../services/conversations.js");
    const notes = await listContactNotes(siteId, opportunity.contact_email);
    res.json({ ok: true, notes });
  } catch (err) { next(err); }
});

// ── Opportunità/affari (26) ──────────────────────────────────────────────

router.get("/admin/opportunities", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const status = ["open", "won", "lost"].includes(req.query.status) ? req.query.status : null;
    const opportunities = await listOpportunities(siteId, { status });
    const pipelines = (await query("SELECT id, name FROM pipelines WHERE site_id = $1 ORDER BY name", [siteId])).rows;
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/opportunities", { opportunities, pipelines, site, sites, siteId, isSuperadmin, status, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.post("/admin/opportunities", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
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
    if (opportunity) res.redirect(`/admin/opportunities/${opportunity.id}?site_id=${siteId}`);
    else res.redirect(`/admin/opportunities?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.get("/admin/opportunities/:id", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    const opportunity = await getOpportunity(siteId, req.params.id);
    if (!opportunity) return res.status(404).render("error", { message: "Opportunità non trovata" });
    const quotes = await listQuotes(siteId, { opportunity_id: opportunity.id });
    const pipelines = (await query("SELECT id, name, stages FROM pipelines WHERE site_id = $1 ORDER BY name", [siteId])).rows;
    res.render("admin/crm/opportunity", { opportunity, quotes, pipelines, siteId, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

router.post("/admin/opportunities/:id/update", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    await updateOpportunity(siteId, req.params.id, {
      title: req.body.title,
      stage: req.body.stage,
      status: req.body.status,
      amount: req.body.amount,
      probability: req.body.probability,
      pipeline_id: req.body.pipeline_id,
      expected_close_at: req.body.expected_close_at,
      notes: req.body.notes,
    });
    res.redirect(`/admin/opportunities/${req.params.id}?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

router.post("/admin/opportunities/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    await deleteOpportunity(siteId, req.params.id);
    res.redirect(`/admin/opportunities?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.post("/admin/opportunities/:id/quotes", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const opportunity = await getOpportunity(siteId, req.params.id);
    if (!opportunity) return res.status(404).render("error", { message: "Opportunità non trovata" });
    // items dal form: descrizione|qty|prezzo per riga
    const items = (req.body.items || "")
      .split("\n")
      .map(line => line.split("|").map(s => s.trim()))
      .filter(parts => parts[0])
      .map(parts => ({ description: parts[0], qty: parseFloat(parts[1]) || 1, price: parseFloat(parts[2]) || 0 }));
    const quote = await createQuote(siteId, {
      opportunity_id: opportunity.id,
      contact_email: opportunity.contact_email,
      title: req.body.title,
      items,
      notes: req.body.notes,
    });
    if (quote) res.redirect(`/admin/opportunities/${opportunity.id}?site_id=${siteId}&saved=1`);
    else res.redirect(`/admin/opportunities/${opportunity.id}?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.post("/admin/quotes/:id/status", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const quote = await setQuoteStatus(siteId, req.params.id, req.body.status);
    res.redirect(safeBack(req.body.back, `/admin/opportunities?site_id=${siteId}`));
  } catch (err) { next(err); }
});

router.post("/admin/quotes/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    await deleteQuote(siteId, req.params.id);
    res.redirect(safeBack(req.body.back, `/admin/opportunities?site_id=${siteId}`));
  } catch (err) { next(err); }
});

export default router;
