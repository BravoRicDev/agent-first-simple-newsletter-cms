import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Note lead + conversazioni (email/WhatsApp).
//
// - contact_notes: timeline di note multiple con autore (umano/agente/sistema)
//   — il vecchio campo singolo contacts.notes resta per compatibilità.
// - conversations: one thread per contact+channel; conversation_messages holds
//   the message history (in/out). The WhatsApp channel is not sent from the CMS
//   (external bot handles delivery): we register messages arriving via agent/MCP
//   APIs, so the entire contact history stays in one place for AI agents to read/write.
//
// Ogni azione emette un evento contact (note_added, conversation_message,
// conversation_status_changed) che alimenta workflow/scoring/segmenti —
// sempre fire-and-forget, mai bloccare il chiamante.
// ─────────────────────────────────────────────────────────────────────────

function emit(siteId, email, eventType, payload) {
  import("./events.js").then(({ emitContactEvent }) =>
    emitContactEvent(siteId, email, eventType, payload)
  ).catch((err) => logger.error(`events emit fallito (${eventType}): ${err.message}`));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// ── Note ─────────────────────────────────────────────────────────────────

export async function addContactNote(siteId, email, { body, authorType = "human", authorName = "" } = {}) {
  const normalized = normalizeEmail(email);
  const cleanBody = String(body || "").trim().slice(0, 10000);
  if (!normalized || !cleanBody) return null;

  const row = (await query(
    `INSERT INTO contact_notes (site_id, contact_email, author_type, author_name, body)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [siteId, normalized, String(authorType).slice(0, 20), String(authorName || "").slice(0, 100), cleanBody]
  )).rows[0];

  emit(siteId, normalized, "note_added", { author_type: row.author_type, author_name: row.author_name });
  return row;
}

export async function listContactNotes(siteId, email) {
  const normalized = normalizeEmail(email);
  const rows = (await query(
    `SELECT id, author_type, author_name, body, created_at FROM contact_notes
     WHERE site_id = $1 AND contact_email = $2 ORDER BY created_at DESC, id DESC`,
    [siteId, normalized]
  )).rows;
  return rows;
}

export async function deleteContactNote(siteId, noteId) {
  return (await query(
    "DELETE FROM contact_notes WHERE id = $1 AND site_id = $2",
    [parseInt(noteId, 10), siteId]
  )).rowCount;
}

// ── Conversazioni ────────────────────────────────────────────────────────

export const CONVERSATION_CHANNELS = ["email", "whatsapp"];
export const CONVERSATION_STATUSES = ["open", "pending", "closed"];

// Upsert sul vincolo UNIQUE(site_id, contact_email, channel).
export async function getOrCreateConversation(siteId, email, channel, { subject = "" } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !CONVERSATION_CHANNELS.includes(channel)) return null;

  const row = (await query(
    `INSERT INTO conversations (site_id, contact_email, channel, subject)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, contact_email, channel) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [siteId, normalized, channel, String(subject || "").slice(0, 255)]
  )).rows[0];
  return row;
}

// Aggiunge un messaggio al thread del contatto+canale (creando la
// conversazione se manca). direction: 'out' = inviato da noi, 'in' = ricevuto
// dal lead. meta: JSON libero (es. campaign_id per deep-link, message_id).
export async function addConversationMessage(siteId, email, channel, { direction = "out", subject = "", body = "", meta = {} } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !CONVERSATION_CHANNELS.includes(channel)) return null;
  if (!["in", "out"].includes(direction)) direction = "out";

  const conversation = await getOrCreateConversation(siteId, normalized, channel, { subject });
  if (!conversation) return null;

  const row = (await query(
    `INSERT INTO conversation_messages (conversation_id, direction, subject, body, meta)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [conversation.id, direction, String(subject || "").slice(0, 255), String(body || "").slice(0, 50000), JSON.stringify(meta || {})]
  )).rows[0];

  await query("UPDATE conversations SET updated_at = NOW(), subject = CASE WHEN $2::text = '' THEN subject ELSE $2 END WHERE id = $1",
    [conversation.id, String(subject || "").slice(0, 255)]);

  emit(siteId, normalized, "conversation_message", { channel, direction, subject: row.subject });
  return { ...row, conversation_id: conversation.id, channel, contact_email: normalized };
}

// Lista conversazioni di un sito, con ultimo messaggio e conteggio.
// Filtri opzionali: email, channel, status.
export async function listConversations(siteId, { email = null, channel = null, status = null } = {}) {
  const params = [siteId];
  let where = "c.site_id = $1";
  if (email) { params.push(normalizeEmail(email)); where += ` AND c.contact_email = $${params.length}`; }
  if (channel && CONVERSATION_CHANNELS.includes(channel)) { params.push(channel); where += ` AND c.channel = $${params.length}`; }
  if (status && CONVERSATION_STATUSES.includes(status)) { params.push(status); where += ` AND c.status = $${params.length}`; }

  const rows = (await query(
    `SELECT c.*, COUNT(m.id)::int AS messages_count,
            (SELECT m2.subject FROM conversation_messages m2
             WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS last_subject,
            (SELECT m3.created_at FROM conversation_messages m3
             WHERE m3.conversation_id = c.id ORDER BY m3.created_at DESC, m3.id DESC LIMIT 1) AS last_message_at
     FROM conversations c
     LEFT JOIN conversation_messages m ON m.conversation_id = c.id
     WHERE ${where}
     GROUP BY c.id
     ORDER BY c.updated_at DESC`,
    params
  )).rows;
  return rows;
}

export async function getConversation(siteId, conversationId) {
  const row = (await query(
    "SELECT * FROM conversations WHERE id = $1 AND site_id = $2",
    [parseInt(conversationId, 10), siteId]
  )).rows[0];
  return row || null;
}

export async function listConversationMessages(siteId, conversationId) {
  const conversation = await getConversation(siteId, conversationId);
  if (!conversation) return null;
  const rows = (await query(
    `SELECT id, direction, subject, body, meta, created_at FROM conversation_messages
     WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
    [conversation.id]
  )).rows;
  return { conversation, messages: rows };
}

export async function setConversationStatus(siteId, conversationId, status) {
  const conversation = await getConversation(siteId, conversationId);
  if (!conversation) return null;
  if (!CONVERSATION_STATUSES.includes(status)) return null;

  await query(
    "UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2",
    [status, conversation.id]
  );
  emit(conversation.site_id, conversation.contact_email, "conversation_status_changed",
    { channel: conversation.channel, to_status: status, from_status: conversation.status });
  return { ...conversation, status };
}

export async function deleteConversation(siteId, conversationId) {
  return (await query(
    "DELETE FROM conversations WHERE id = $1 AND site_id = $2",
    [parseInt(conversationId, 10), siteId]
  )).rowCount;
}

// Per GDPR export: tutte le conversazioni del contatto coi messaggi.
export async function listConversationsForExport(siteId, email) {
  const normalized = normalizeEmail(email);
  const conversations = (await query(
    `SELECT * FROM conversations WHERE site_id = $1 AND contact_email = $2 ORDER BY created_at`,
    [siteId, normalized]
  )).rows;
  for (const c of conversations) {
    c.messages = (await query(
      `SELECT direction, subject, body, meta, created_at FROM conversation_messages
       WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
      [c.id]
    )).rows;
  }
  return conversations;
}
