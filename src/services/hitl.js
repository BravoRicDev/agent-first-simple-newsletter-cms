import { query } from "../db.js";
import { logger } from "./logger.js";
import { auditLog } from "./audit.js";
import { createTask } from "./tasks.js";
import { addConversationMessage, setConversationStatus } from "./conversations.js";
import { setContactFields } from "./contacts.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 32 — Human-in-the-loop: coda di approvazione.
//
// L'agente AI prepara un'azione sensibile (messaggio out, task, modifica
// contatto, campagna…) e la mette in coda con kind + payload JSONB libero.
// Un operatore approva o rifiuta; solo all'approvazione il payload viene
// eseguito. Se l'esecuzione fallisce la decisione resta comunque
// 'approved' e l'errore viene restituito come action_error (l'umano ha già
// deciso: non si rispedisce in coda, si logga e si lascia gestire).
//
// Nessuna FK verso conversation/task: il payload è opaco per lo schema e
// interpretato qui, kind per kind. Il canale whatsapp NON viene inviato
// dal CMS (è un bot esterno a inviare): qui registriamo solo il messaggio
// OUT nel thread conversazioni, come ovunque nel resto del codice.
// ─────────────────────────────────────────────────────────────────────────

export const APPROVAL_KINDS = ["outbound_message", "task", "quote", "campaign", "contact_change", "custom"];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected"];

// ── Enqueue ──────────────────────────────────────────────────────────────

export async function enqueueApproval(siteId, { kind, payload, requested_by = "" } = {}) {
  const cleanKind = APPROVAL_KINDS.includes(kind) ? kind : "custom";
  const cleanPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const result = await query(
    `INSERT INTO approval_queue (site_id, kind, payload, requested_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [siteId, cleanKind, JSON.stringify(cleanPayload), String(requested_by || "").trim().slice(0, 255)]
  );
  const approval = result.rows[0];
  await auditLog({
    siteId,
    entityType: "approval",
    entityId: approval.id,
    action: "approval_enqueue",
    newData: { kind: approval.kind, payload: cleanPayload, requested_by: approval.requested_by },
  });
  return approval;
}

// ── List ─────────────────────────────────────────────────────────────────

export async function listApprovals(siteId, { status = null, kind = null, limit = 50, offset = 0 } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (status && APPROVAL_STATUSES.includes(status)) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (kind && APPROVAL_KINDS.includes(kind)) {
    params.push(kind);
    where += ` AND kind = $${params.length}`;
  }
  params.push(Math.min(parseInt(limit, 10) || 50, 200), Math.max(parseInt(offset, 10) || 0, 0));
  const rows = (await query(
    `SELECT * FROM approval_queue WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )).rows;
  return rows;
}

// ── Approve / Reject ─────────────────────────────────────────────────────

// Ruoli che possono decidere: SOLO operatori UMANI admin/superadmin.
// Fix CORREZIONI-TRACCIATE: un token API (agente/runtime) non può mai
// approvare o rifiutare — il human-in-the-loop deve garantire controllo
// umano, non una macchina che auto-approva le proprie azioni.
const HUMAN_DECIDER_ROLES = new Set(["superadmin", "admin"]);

// Identità stabile e leggibile dal token autenticato (mai dal body):
//   user:<email> oppure user:<sub>.
function actorIdentity(actor = {}) {
  const email = String(actor.email || "").trim().toLowerCase();
  return `user:${email || actor.sub || "unknown"}`;
}

async function canDecide(actor = {}) {
  if (!actor || !actor.sub) return { ok: false, error: "Autenticazione richiesta" };
  if (actor.apiToken) return { ok: false, error: "Solo operatori umani possono approvare/rifiutare (token API non consentito)" };
  if (!HUMAN_DECIDER_ROLES.has(actor.role)) return { ok: false, error: "Solo operatori admin possono approvare/rifiutare" };
  return { ok: true };
}

// Esegue il payload di un'approvazione 'approved' in base al kind.
// Non lancia MAI: ritorna null se ok, altrimenti il messaggio d'errore.
async function executeApprovalAction(approval) {
  const { kind, payload } = approval;
  try {
    if (kind === "task" && payload?.action_type === "create_task" && payload.task) {
      await createTask(approval.site_id, payload.task);
      return null;
    }
    if (kind === "outbound_message" && payload?.message) {
      const msg = payload.message;
      if (!msg.channel || !msg.email) return "channel ed email obbligatori per outbound_message";
      const message = await addConversationMessage(approval.site_id, msg.email, msg.channel, {
        direction: "out",
        subject: msg.subject || "",
        body: msg.body || "",
        meta: msg.meta || {},
      });
      if (!message) return "canale non valido o email mancante";
      await setConversationStatus(approval.site_id, message.conversation_id, "open");
      return null;
    }
    if (kind === "contact_change" && payload?.email && payload?.fields) {
      await setContactFields(approval.site_id, payload.email, payload.fields);
      return null;
    }
    // kind custom/quote/campaign (o payload non riconosciuto): nessuna
    // azione automatica — l'approvazione vale come consenso esplicito.
    return null;
  } catch (err) {
    logger.error(`approval ${approval.id} action fallita (${kind}): ${err.message}`);
    return err.message;
  }
}

// Approva una richiesta. `actor` è l'identità DAL TOKEN (email/sub/role/
// apiToken), mai dal body: decided_by viene derivato qui.
// Ritorna { approval, action_error } se approvata; { notFound } se la riga
// non esiste; { conflict, approval } se non era più 'pending';
// { forbidden, error } se l'attore non è un umano admin;
// { selfApproval, approval } se l'attore ha richiesto lui stesso.
export async function approveApproval(siteId, id, actor = {}) {
  const decision = await canDecide(actor);
  if (!decision.ok) return { forbidden: decision.error };
  const decidedBy = actorIdentity(actor);

  const existing = (await query(
    "SELECT * FROM approval_queue WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (!existing) return { notFound: true };
  if (existing.status !== "pending") return { conflict: true, approval: existing };
  if (existing.requested_by && existing.requested_by.startsWith("user:") && existing.requested_by === decidedBy) {
    return { selfApproval: true, approval: existing };
  }

  const result = await query(
    `UPDATE approval_queue SET status = 'approved', decided_by = $3, decided_at = NOW()
     WHERE id = $1 AND site_id = $2 AND status = 'pending'
     RETURNING *`,
    [parseInt(id, 10), siteId, decidedBy]
  );
  if (result.rowCount === 0) {
    const fresh = (await query(
      "SELECT * FROM approval_queue WHERE id = $1 AND site_id = $2",
      [parseInt(id, 10), siteId]
    )).rows[0];
    if (!fresh) return { notFound: true };
    return { conflict: true, approval: fresh };
  }

  const approval = result.rows[0];
  const actionError = await executeApprovalAction(approval);
  if (actionError) approval.action_error = actionError;

  await auditLog({
    siteId,
    entityType: "approval",
    entityId: approval.id,
    action: "approval_approve",
    newData: { kind: approval.kind, decided_by: approval.decided_by, action_error: actionError || null },
  });
  return { approval, action_error: actionError || null };
}

// Rifiuta una richiesta. Stesse regole di approveApproval.
export async function rejectApproval(siteId, id, actor = {}) {
  const decision = await canDecide(actor);
  if (!decision.ok) return { forbidden: decision.error };
  const decidedBy = actorIdentity(actor);

  const existing = (await query(
    "SELECT * FROM approval_queue WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (!existing) return { notFound: true };
  if (existing.status !== "pending") return { conflict: true, approval: existing };
  if (existing.requested_by && existing.requested_by.startsWith("user:") && existing.requested_by === decidedBy) {
    return { selfApproval: true, approval: existing };
  }

  const result = await query(
    `UPDATE approval_queue SET status = 'rejected', decided_by = $3, decided_at = NOW()
     WHERE id = $1 AND site_id = $2 AND status = 'pending'
     RETURNING *`,
    [parseInt(id, 10), siteId, decidedBy]
  );
  if (result.rowCount === 0) {
    const fresh = (await query(
      "SELECT * FROM approval_queue WHERE id = $1 AND site_id = $2",
      [parseInt(id, 10), siteId]
    )).rows[0];
    if (!fresh) return { notFound: true };
    return { conflict: true, approval: fresh };
  }

  const approval = result.rows[0];
  await auditLog({
    siteId,
    entityType: "approval",
    entityId: approval.id,
    action: "approval_reject",
    newData: { kind: approval.kind, decided_by: approval.decided_by },
  });
  return { approval };
}

export async function deleteApproval(siteId, id) {
  return (await query(
    "DELETE FROM approval_queue WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rowCount;
}
