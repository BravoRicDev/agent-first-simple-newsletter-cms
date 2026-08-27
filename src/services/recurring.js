import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 27: Task ricorrenti + follow-up intelligente.
//
// - recurring_tasks: template di task rigenerato a scadenza in righe della
//   tabella `tasks` (tick: generateDueRecurringTasks).
// - followup_rules: "aspetta risposta → se N giorni senza risposta avvisa".
//   Il tick checkFollowups cerca conversazioni il cui ULTIMO messaggio è
//   outbound e più vecchio di wait_days, con stato in statuses, e applica
//   l'azione configurata. Idempotente: una regola non ri-scatta finché non
//   arriva un nuovo messaggio in dopo l'ultima esecuzione (followup_runs).
// - followup_runs: log delle esecuzioni (anche per l'idempotenza).
//
// Entrambi i tick sono safe: try/catch per ogni regola/task, mai crashare.
// ─────────────────────────────────────────────────────────────────────────

const CADENCES = ["daily", "weekly", "monthly", "custom"];
const FOLLOWUP_CHANNELS = ["conversation", "email", "whatsapp", "any"];
const FOLLOWUP_ACTIONS = ["create_task", "notify_email", "add_tag"];

// ── Task ricorrenti ──────────────────────────────────────────────────────

export async function listRecurringTasks(siteId) {
  const rows = (await query(
    `SELECT * FROM recurring_tasks WHERE site_id = $1 ORDER BY next_due_at ASC NULLS LAST, created_at DESC`,
    [siteId]
  )).rows;
  return rows;
}

export async function createRecurringTask(siteId, data = {}) {
  const title = String(data.title || "").trim().slice(0, 255);
  if (!title) throw new Error("Titolo obbligatorio");
  const cadence = CADENCES.includes(data.cadence) ? data.cadence : "daily";
  const intervalDays = Math.max(1, parseInt(data.interval_days, 10) || 1);
  const nextDueAt = data.next_due_at ? new Date(data.next_due_at) : new Date();
  const assigneeId = data.assignee_id ? parseInt(data.assignee_id, 10) : null;
  const result = await query(
    `INSERT INTO recurring_tasks
       (site_id, title, notes, assignee_id, cadence, interval_days, next_due_at, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      siteId,
      title,
      String(data.notes || "").slice(0, 2000),
      assigneeId,
      cadence,
      intervalDays,
      nextDueAt,
      data.active !== undefined ? !!data.active : true,
    ]
  );
  return result.rows[0];
}

export async function updateRecurringTask(siteId, taskId, data = {}) {
  const current = (await query(
    "SELECT * FROM recurring_tasks WHERE id = $1 AND site_id = $2",
    [taskId, siteId]
  )).rows[0];
  if (!current) return null;
  const next = {
    title: data.title !== undefined ? String(data.title).trim().slice(0, 255) : current.title,
    notes: data.notes !== undefined ? String(data.notes).slice(0, 2000) : current.notes,
    assignee_id: data.assignee_id !== undefined ? (data.assignee_id ? parseInt(data.assignee_id, 10) : null) : current.assignee_id,
    cadence: data.cadence !== undefined ? (CADENCES.includes(data.cadence) ? data.cadence : current.cadence) : current.cadence,
    interval_days: data.interval_days !== undefined ? Math.max(1, parseInt(data.interval_days, 10) || 1) : current.interval_days,
    next_due_at: data.next_due_at !== undefined ? (data.next_due_at ? new Date(data.next_due_at) : null) : current.next_due_at,
    active: data.active !== undefined ? !!data.active : current.active,
  };
  if (!next.title) throw new Error("Titolo obbligatorio");
  const result = await query(
    `UPDATE recurring_tasks SET title = $1, notes = $2, assignee_id = $3, cadence = $4,
       interval_days = $5, next_due_at = $6, active = $7, updated_at = NOW()
     WHERE id = $8 AND site_id = $9 RETURNING *`,
    [next.title, next.notes, next.assignee_id, next.cadence, next.interval_days,
     next.next_due_at, next.active, taskId, siteId]
  );
  return result.rows[0];
}

export async function deleteRecurringTask(siteId, taskId) {
  const result = await query(
    "DELETE FROM recurring_tasks WHERE id = $1 AND site_id = $2",
    [taskId, siteId]
  );
  return result.rowCount;
}

// Prossima scadenza: daily=+1 giorno, weekly=+7, monthly=+1 mese (setMonth),
// custom=+interval_days. Ancorata a next_due_at corrente, non a NOW(), così
// lo schedule originale resta stabile anche se un tick salta un giro.
function computeNextDue(task) {
  const base = task.next_due_at ? new Date(task.next_due_at) : new Date();
  const next = new Date(base);
  switch (task.cadence) {
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
    case "custom":
      next.setDate(next.getDate() + (parseInt(task.interval_days, 10) || 1));
      break;
    case "daily":
    default:
      next.setDate(next.getDate() + 1);
      break;
  }
  return next;
}

// Rigenera le task ricorrenti scadute (next_due_at <= NOW()) in righe della
// tabella `tasks`. siteId opzionale: se omesso, processa tutti i siti.
export async function generateDueRecurringTasks(siteId = null) {
  const params = [];
  let where = "active = true AND next_due_at IS NOT NULL AND next_due_at <= NOW()";
  if (siteId) {
    params.push(parseInt(siteId, 10));
    where += ` AND site_id = $${params.length}`;
  }
  const rows = (await query(
    `SELECT * FROM recurring_tasks WHERE ${where} ORDER BY next_due_at ASC FOR UPDATE SKIP LOCKED`,
    params
  )).rows;

  let generated = 0;
  for (const task of rows) {
    try {
      await query(
        `INSERT INTO tasks (site_id, email, assignee_id, title, notes, due_at, status, created_by)
         VALUES ($1, '', $2, $3, $4, $5, 'open', NULL)`,
        [task.site_id, task.assignee_id, task.title, task.notes, task.next_due_at]
      );
      const nextDue = computeNextDue(task);
      await query(
        `UPDATE recurring_tasks SET next_due_at = $1, last_generated_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [nextDue, task.id]
      );
      generated++;
    } catch (err) {
      logger.error(`Recurring task #${task.id} fallita: ${err.message}`);
    }
  }
  return { generated };
}

// ── Follow-up rules ──────────────────────────────────────────────────────

export async function listFollowupRules(siteId) {
  const rows = (await query(
    "SELECT * FROM followup_rules WHERE site_id = $1 ORDER BY name",
    [siteId]
  )).rows;
  return rows;
}

export async function createFollowupRule(siteId, data = {}) {
  const name = String(data.name || "").trim().slice(0, 255);
  if (!name) throw new Error("Nome obbligatorio");
  const waitDays = Math.max(0, parseInt(data.wait_days, 10) || 3);
  const channel = FOLLOWUP_CHANNELS.includes(data.channel) ? data.channel : "conversation";
  const actionType = FOLLOWUP_ACTIONS.includes(data.action_type) ? data.action_type : null;
  if (!actionType) throw new Error("action_type non valido (create_task | notify_email | add_tag)");
  const statuses = Array.isArray(data.statuses) && data.statuses.length
    ? data.statuses.map((s) => String(s).slice(0, 20))
    : ["pending", "open"];
  const result = await query(
    `INSERT INTO followup_rules (site_id, name, wait_days, channel, statuses, action_type, action_config, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      siteId,
      name,
      waitDays,
      channel,
      JSON.stringify(statuses),
      actionType,
      JSON.stringify(data.action_config && typeof data.action_config === "object" ? data.action_config : {}),
      data.active !== undefined ? !!data.active : true,
    ]
  );
  return result.rows[0];
}

export async function updateFollowupRule(siteId, ruleId, data = {}) {
  const current = (await query(
    "SELECT * FROM followup_rules WHERE id = $1 AND site_id = $2",
    [ruleId, siteId]
  )).rows[0];
  if (!current) return null;
  const next = {
    name: data.name !== undefined ? String(data.name).trim().slice(0, 255) : current.name,
    wait_days: data.wait_days !== undefined ? Math.max(0, parseInt(data.wait_days, 10) || 0) : current.wait_days,
    channel: data.channel !== undefined ? (FOLLOWUP_CHANNELS.includes(data.channel) ? data.channel : current.channel) : current.channel,
    statuses: data.statuses !== undefined ? (Array.isArray(data.statuses) && data.statuses.length ? data.statuses.map((s) => String(s).slice(0, 20)) : current.statuses) : current.statuses,
    action_type: data.action_type !== undefined ? (FOLLOWUP_ACTIONS.includes(data.action_type) ? data.action_type : current.action_type) : current.action_type,
    action_config: data.action_config !== undefined ? (data.action_config && typeof data.action_config === "object" ? data.action_config : {}) : current.action_config,
    active: data.active !== undefined ? !!data.active : current.active,
  };
  if (!next.name) throw new Error("Nome obbligatorio");
  const result = await query(
    `UPDATE followup_rules SET name = $1, wait_days = $2, channel = $3, statuses = $4,
       action_type = $5, action_config = $6, active = $7, updated_at = NOW()
     WHERE id = $8 AND site_id = $9 RETURNING *`,
    [next.name, next.wait_days, next.channel, JSON.stringify(next.statuses),
     next.action_type, JSON.stringify(next.action_config), next.active, ruleId, siteId]
  );
  return result.rows[0];
}

export async function deleteFollowupRule(siteId, ruleId) {
  const result = await query(
    "DELETE FROM followup_rules WHERE id = $1 AND site_id = $2",
    [ruleId, siteId]
  );
  return result.rowCount;
}

// ── Tick follow-up ───────────────────────────────────────────────────────

// Conversazioni candidate per una regola: canale matchante, stato in
// statuses, ULTIMO messaggio direction='out' e vecchio di wait_days, e
// nessuna followup_runs per (rule_id, conversation_id) creata DOPO l'ultimo
// messaggio in della conversazione (idempotenza: un nuovo messaggio in
// dopo l'esecuzione riabilita la regola).
async function findEligibleConversations(rule) {
  const channelFilter = rule.channel === "email" ? ["email"]
    : rule.channel === "whatsapp" ? ["whatsapp"]
    : null; // 'conversation' | 'any' → tutti i canali
  const statuses = Array.isArray(rule.statuses) && rule.statuses.length
    ? rule.statuses
    : ["pending", "open"];

  const params = [rule.site_id, statuses, rule.wait_days, rule.id];
  let channelSql = "";
  if (channelFilter) {
    params.push(channelFilter);
    channelSql = `AND c.channel = ANY($${params.length}::text[])`;
  }

  const rows = (await query(
    `SELECT c.id AS conversation_id, c.site_id, c.contact_email, c.channel,
            lm.direction AS last_direction, lm.created_at AS last_message_at
     FROM conversations c
     JOIN LATERAL (
       SELECT m.direction, m.created_at FROM conversation_messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1
     ) lm ON TRUE
     WHERE c.site_id = $1
       ${channelSql}
       AND c.status = ANY($2::text[])
       AND lm.direction = 'out'
       AND lm.created_at <= NOW() - make_interval(days => $3)
       AND NOT EXISTS (
         SELECT 1 FROM followup_runs fr
         WHERE fr.rule_id = $4 AND fr.conversation_id = c.id
           AND fr.created_at > (
             SELECT COALESCE(MAX(m2.created_at), '-infinity') FROM conversation_messages m2
             WHERE m2.conversation_id = c.id AND m2.direction = 'in'
           )
       )`,
    params
  )).rows;
  return rows;
}

async function applyFollowupAction(rule, conv) {
  let action = rule.action_type;
  const cfg = rule.action_config || {};

  switch (rule.action_type) {
    case "create_task": {
      const title = String(cfg.title || `Follow-up: ${rule.name}`).trim().slice(0, 255);
      const notes = cfg.notes
        ? String(cfg.notes).slice(0, 2000)
        : `Follow-up automatico — contatto: ${conv.contact_email}`;
      await query(
        `INSERT INTO tasks (site_id, email, assignee_id, title, notes, due_at, status, created_by)
         VALUES ($1, $2, $3, $4, $5, NOW(), 'open', NULL)`,
        [
          conv.site_id,
          conv.contact_email,
          cfg.assignee_id ? parseInt(cfg.assignee_id, 10) : null,
          title,
          notes,
        ]
      );
      break;
    }
    case "notify_email": {
      const { sendEmail } = await import("./email.js");
      const to = String(cfg.to || conv.contact_email || "").trim();
      if (!to) throw new Error("Nessun destinatario email");
      const subject = String(cfg.subject || `Follow-up: ${rule.name}`).slice(0, 255);
      const body = String(cfg.body ||
        `Nessuna risposta da ${conv.contact_email} da ${rule.wait_days} giorni.`);
      await sendEmail(to, subject, body);
      break;
    }
    case "add_tag": {
      // setContactFields(siteId, email, { tags, status, notes, value_estimate })
      // riscrive TUTTI i campi → leggiamo il record prima e preserviamo
      // status/notes/value_estimate esistenti, aggiungendo solo il tag.
      const { getContactRecord, setContactFields } = await import("./contacts.js");
      const tag = String(cfg.tag || (Array.isArray(cfg.tags) ? cfg.tags[0] : "") || "followup").trim().slice(0, 100);
      const record = await getContactRecord(conv.site_id, conv.contact_email);
      const existing = Array.isArray(record.tags) ? record.tags : [];
      if (!existing.includes(tag)) existing.push(tag);
      await setContactFields(conv.site_id, conv.contact_email, {
        tags: existing,
        status: record.status,
        notes: record.notes,
        value_estimate: record.value_estimate,
      });
      break;
    }
    default:
      throw new Error(`action_type sconosciuto: ${rule.action_type}`);
  }

  await query(
    `INSERT INTO followup_runs (site_id, rule_id, conversation_id, email, action, status)
     VALUES ($1, $2, $3, $4, $5, 'ok')`,
    [conv.site_id, rule.id, conv.conversation_id, conv.contact_email, action]
  );
}

// Esegue tutte le regole follow-up attive. siteId opzionale: se omesso,
// processa tutti i siti. Ritorna { checked, executed }.
export async function checkFollowups(siteId = null) {
  const params = [];
  let where = "active = true";
  if (siteId) {
    params.push(parseInt(siteId, 10));
    where += ` AND site_id = $${params.length}`;
  }
  const rules = (await query(`SELECT * FROM followup_rules WHERE ${where}`, params)).rows;

  let checked = 0;
  let executed = 0;
  for (const rule of rules) {
    checked++;
    let conversations = [];
    try {
      conversations = await findEligibleConversations(rule);
    } catch (err) {
      logger.error(`Followup rule #${rule.id} (${rule.name}): scansione fallita: ${err.message}`);
      continue;
    }
    for (const conv of conversations) {
      try {
        await applyFollowupAction(rule, conv);
        executed++;
      } catch (err) {
        logger.error(`Followup rule #${rule.id} (${rule.name}) su conversazione #${conv.conversation_id}: ${err.message}`);
        try {
          await query(
            `INSERT INTO followup_runs (site_id, rule_id, conversation_id, email, action, status)
             VALUES ($1, $2, $3, $4, $5, 'error')`,
            [conv.site_id, rule.id, conv.conversation_id, conv.contact_email, rule.action_type]
          );
        } catch { /* log già emesso sopra */ }
      }
    }
  }
  return { checked, executed };
}

// ── Log esecuzioni ───────────────────────────────────────────────────────

export async function listFollowupRuns(siteId, { ruleId = null, email = null, limit = 100 } = {}) {
  const params = [siteId];
  let where = "fr.site_id = $1";
  if (ruleId) {
    params.push(parseInt(ruleId, 10));
    where += ` AND rule_id = $${params.length}`;
  }
  if (email) {
    params.push(String(email).trim().toLowerCase());
    where += ` AND email = $${params.length}`;
  }
  params.push(Math.min(parseInt(limit, 10) || 100, 500));
  const rows = (await query(
    `SELECT fr.*, r.name AS rule_name
     FROM followup_runs fr LEFT JOIN followup_rules r ON r.id = fr.rule_id
     WHERE ${where} ORDER BY fr.created_at DESC, fr.id DESC LIMIT $${params.length}`,
    params
  )).rows;
  return rows;
}
