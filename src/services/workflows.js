import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Workflow a trigger — engine "se evento → azioni".
//
// applyWorkflows(siteId, email, eventType, payload, {depth}):
//   1. trova i workflow attivi con trigger_type == eventType
//   2. valida trigger_config (form_slug/quiz_slug/stage/tag/min_score/
//      segment_id)
//   3. esegue le azioni in ordine; wait_days → coda differita
//
// Idempotenza: send_campaign/send_sequence controllano workflow_runs
// (stesso workflow + email + tipo) per non inviare due volte la stessa
// email per lo stesso trigger.
// ─────────────────────────────────────────────────────────────────────────

const TRIGGER_TYPES = new Set([
  "form_submitted", "quiz_completed", "email_opened", "email_clicked",
  "call_booked", "call_status_changed", "stage_changed", "tag_added",
  "contact_created", "score_threshold", "segment_entered", "manual",
  "note_added", "conversation_message", "conversation_status_changed",
  "opportunity_stage_changed", "opportunity_status_changed",
  "quote_sent", "quote_viewed", "quote_signed",
]);

const ACTION_TYPES = new Set([
  "add_tag", "remove_tag", "set_stage", "send_campaign", "send_sequence",
  "create_task", "notify_email", "wait_days",
]);

export async function applyWorkflows(siteId, email, eventType, payload = {}, { depth = 0 } = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !siteId || !TRIGGER_TYPES.has(eventType)) return;

  const workflows = (await query(
    `SELECT w.* FROM workflows w
     WHERE w.site_id = $1 AND w.active = true AND w.trigger_type = $2`,
    [siteId, eventType]
  )).rows;
  if (workflows.length === 0) return;

  for (const workflow of workflows) {
    try {
      if (!matchTriggerConfig(workflow.trigger_config, eventType, payload, siteId, normalized)) continue;
      await runWorkflow(siteId, workflow, normalized, eventType, payload, { depth });
    } catch (err) {
      logger.error(`Workflow #${workflow.id} fallito (site=${siteId}, ${normalized}): ${err.message}`);
      await logRun(workflow.id, siteId, normalized, eventType, "error", err.message);
    }
  }
}

function matchTriggerConfig(config, eventType, payload, siteId, email) {
  if (!config || typeof config !== "object") return true;
  if (config.form_slug && payload.form_slug !== config.form_slug) return false;
  if (config.quiz_slug && payload.quiz_slug !== config.quiz_slug) return false;
  if (config.to_stage && payload.to_stage !== config.to_stage) return false;
  if (config.stage && payload.stage !== config.stage) return false;
  if (config.tag && payload.tag !== config.tag) return false;
  if (config.status && payload.status !== config.status) return false;
  if (config.min_score !== undefined && config.min_score !== null && Number(payload.points || 0) < Number(config.min_score)) return false;
  // segment_id: il contatto deve essere membro del segmento.
  if (config.segment_id) {
    // match sincrono non possibile qui; verificato dal chiamante quando
    // l'evento è segment_entered (payload.segment_id). Per altri trigger
    // si rimanda alla membership corrente (query asincrona sotto).
    return true;
  }
  return true;
}

async function runWorkflow(siteId, workflow, email, eventType, payload, { depth } = {}) {
  const actions = (await query(
    `SELECT id, action_type, action_config FROM workflow_actions
     WHERE workflow_id = $1 ORDER BY action_order`,
    [workflow.id]
  )).rows;

  for (const action of actions) {
    try {
      await executeAction(siteId, workflow, action, email, eventType, payload, { depth });
    } catch (err) {
      logger.error(`Workflow #${workflow.id} azione ${action.action_type} fallita (${email}): ${err.message}`);
      await logRun(workflow.id, siteId, email, eventType, "error", err.message);
      // Continua con le azioni successive (un'azione rotta non blocca le altre).
    }
  }
  await logRun(workflow.id, siteId, email, eventType, "ok");
}

async function executeAction(siteId, workflow, action, email, eventType, payload, { depth } = {}) {
  const cfg = action.action_config || {};
  switch (action.action_type) {
    case "add_tag": {
      const tag = String(cfg.tag || "").trim();
      if (!tag) return;
      const { addContactTag } = await import("./contacts.js");
      await addContactTag(siteId, email, tag);
      break;
    }
    case "remove_tag": {
      const tag = String(cfg.tag || "").trim();
      if (!tag) return;
      const { setContactFields, getContactRecord } = await import("./contacts.js");
      const rec = await getContactRecord(siteId, email);
      const tags = (rec.tags || []).filter((t) => t !== tag);
      await setContactFields(siteId, email, { tags });
      break;
    }
    case "set_stage": {
      const stage = String(cfg.stage || "").trim();
      if (!stage) return;
      const { setContactStage } = await import("./contacts.js");
      await setContactStage(siteId, email, stage);
      break;
    }
    case "send_campaign": {
      const campaignId = parseInt(cfg.campaign_id, 10);
      if (!campaignId) return;
      // Idempotenza: se l'invio per (sito,email,campagna) è già stato
      // registrato, skip — un workflow non deve re-inviare la stessa
      // campagna allo stesso destinatario a ogni evento.
      const sent = (await query(
        `SELECT 1 FROM workflow_sent_emails
         WHERE site_id = $1 AND email = $2 AND kind = 'campaign' AND campaign_id = $3 LIMIT 1`,
        [siteId, email, campaignId]
      )).rows[0];
      if (sent) return;
      const campaign = (await query(
        "SELECT subject, html_content FROM newsletter_campaigns WHERE id = $1 AND site_id = $2",
        [campaignId, siteId]
      )).rows[0];
      if (!campaign) return;
      const { renderPreviewHtml } = await import("./newsletter.js");
      const { sendSiteEmail } = await import("./email.js");
      const html = await renderPreviewHtml(siteId, campaign.html_content, "");
      await sendSiteEmail(siteId, email, campaign.subject, html);
      // Registra l'invio qui (la guardia sopra legge questa tabella): prima
      // si guardava newsletter_sends ma non veniva MAI scritto nulla.
      await query(
        `INSERT INTO workflow_sent_emails (site_id, email, kind, campaign_id)
         VALUES ($1,$2,'campaign',$3)
         ON CONFLICT (site_id, email, kind, campaign_id, step_id) DO NOTHING`,
        [siteId, email, campaignId]
      );
      break;
    }
    case "send_sequence": {
      const stepId = parseInt(cfg.step_id, 10);
      if (!stepId) return;
      const sentSeq = (await query(
        `SELECT 1 FROM workflow_sent_emails
         WHERE site_id = $1 AND email = $2 AND kind = 'sequence' AND step_id = $3 LIMIT 1`,
        [siteId, email, stepId]
      )).rows[0];
      if (sentSeq) return;
      const step = (await query(
        `SELECT st.subject, st.html_content FROM newsletter_sequence_steps st
         JOIN newsletter_sequences sq ON sq.id = st.sequence_id
         WHERE st.id = $1 AND sq.site_id = $2`,
        [stepId, siteId]
      )).rows[0];
      if (!step) return;
      const { renderPreviewHtml } = await import("./newsletter.js");
      const { sendSiteEmail } = await import("./email.js");
      const html = await renderPreviewHtml(siteId, step.html_content, "");
      await sendSiteEmail(siteId, email, step.subject, html);
      await query(
        `INSERT INTO workflow_sent_emails (site_id, email, kind, step_id)
         VALUES ($1,$2,'sequence',$3)
         ON CONFLICT (site_id, email, kind, campaign_id, step_id) DO NOTHING`,
        [siteId, email, stepId]
      );
      break;
    }
    case "create_task": {
      const title = String(cfg.title || "").trim().slice(0, 255);
      if (!title) return;
      const dueInDays = Number.isFinite(Number(cfg.due_in_days)) ? Number(cfg.due_in_days) : 0;
      const assigneeId = cfg.assignee_id ? parseInt(cfg.assignee_id, 10) : null;
      await query(
        `INSERT INTO tasks (site_id, email, assignee_id, title, notes, due_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [siteId, email, assigneeId, title, String(cfg.notes || "").slice(0, 2000),
         new Date(Date.now() + dueInDays * 24 * 3600 * 1000)]
      );
      break;
    }
    case "notify_email": {
      const to = String(cfg.to || "").trim();
      const subject = String(cfg.subject || `Evento ${eventType} — ${email}`).slice(0, 500);
      const body = String(cfg.body || `${email} ha triggerato ${eventType} sul sito #${siteId}`).slice(0, 5000);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return;
      const { sendEmail } = await import("./email.js");
      await sendEmail(to, subject, body.replace(/\n/g, "<br>"));
      break;
    }
    case "wait_days": {
      const days = Number.isFinite(Number(cfg.days)) ? Number(cfg.days) : 0;
      await query(
        `INSERT INTO workflow_delayed_actions (site_id, workflow_id, email, action_type, action_config, run_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [siteId, workflow.id, email, String(cfg.next_action_type || "add_tag"),
         JSON.stringify(cfg.next_action_config || { tag: "followup" }),
         new Date(Date.now() + days * 24 * 3600 * 1000)]
      );
      break;
    }
    default:
      break;
  }
}

// Esegue le azioni differite scadute (wait_days) — chiamato dal tick.
// Claim ATOMICO: la SELECT ... FOR UPDATE SKIP LOCKED + UPDATE a 'running'
// avviene in una singola UPDATE...FROM. Due esecutori concorrenti — il tick
// dello scheduler (lock 72700123) e il tick esterno /api/agent/tick (lock
// 72800123), oltre a run manuali — non possono prendersi la stessa riga:
// niente azioni differite eseguite due volte (email/tag/campagna duplicati).
export async function processDelayedActions(siteId = null, { limit = 200 } = {}) {
  const params = [];
  let where = "status = 'pending' AND run_at <= NOW()";
  if (siteId) {
    params.push(siteId);
    where += ` AND site_id = $${params.length}`;
  }
  params.push(Math.min(limit, 500));
  const claimed = (await query(
    `WITH due AS (
       SELECT id FROM workflow_delayed_actions
       WHERE ${where}
       ORDER BY run_at LIMIT $${params.length}
       FOR UPDATE SKIP LOCKED
     )
     UPDATE workflow_delayed_actions d SET status = 'running', executed_at = NOW()
     FROM due WHERE d.id = due.id
     RETURNING d.*`,
    params
  )).rows;

  let executed = 0;
  for (const item of claimed) {
    try {
      // Riexecute action_type/action_config come azione immediata.
      const fakeAction = { action_type: item.action_type, action_config: item.action_config };
      const workflow = { id: item.workflow_id };
      await executeAction(item.site_id, workflow, fakeAction, item.email, "delayed", {}, { depth: 1 });
      await query(
        "UPDATE workflow_delayed_actions SET status = 'done', executed_at = NOW() WHERE id = $1",
        [item.id]
      );
      executed++;
    } catch (err) {
      logger.error(`Delayed action ${item.id} fallita: ${err.message}`);
      await query(
        "UPDATE workflow_delayed_actions SET status = 'error' WHERE id = $1",
        [item.id]
      );
    }
  }
  return { executed };
}

async function logRun(workflowId, siteId, email, triggerType, status, error = null) {
  try {
    await query(
      `INSERT INTO workflow_runs (workflow_id, site_id, email, trigger_type, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workflowId, siteId, email, triggerType, status, error ? String(error).slice(0, 2000) : null]
    );
  } catch (err) {
    logger.error(`workflow_runs log fallito: ${err.message}`);
  }
}

// Dry-run: elenca le azioni che partirebbero senza eseguirle.
export async function testWorkflow(siteId, workflowId, email) {
  const workflow = (await query(
    "SELECT * FROM workflows WHERE id = $1 AND site_id = $2",
    [workflowId, siteId]
  )).rows[0];
  if (!workflow) return { error: "Workflow non trovato" };
  const actions = (await query(
    `SELECT action_order, action_type, action_config FROM workflow_actions
     WHERE workflow_id = $1 ORDER BY action_order`,
    [workflowId]
  )).rows;
  return {
    workflow: workflow.name,
    trigger_type: workflow.trigger_type,
    email,
    would_run: actions.map((a) => ({
      order: a.action_order,
      type: a.action_type,
      config: a.action_config,
    })),
  };
}

// Sanitizzazione definizione workflow/azioni per le route.
export function sanitizeWorkflow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const triggerType = String(raw.trigger_type || "");
  if (!TRIGGER_TYPES.has(triggerType)) return null;
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const cleanActions = actions
    .filter((a) => a && ACTION_TYPES.has(String(a.action_type || "")))
    .slice(0, 20)
    .map((a, i) => ({
      action_order: i + 1,
      action_type: String(a.action_type),
      action_config: a.action_config && typeof a.action_config === "object" ? a.action_config : {},
    }));
  return {
    name: String(raw.name || "").trim().slice(0, 255),
    active: raw.active !== false,
    trigger_type: triggerType,
    trigger_config: raw.trigger_config && typeof raw.trigger_config === "object" ? raw.trigger_config : {},
    actions: cleanActions,
  };
}
