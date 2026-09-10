import { Router } from "express";
import { sendError, getPaging, requireAnyId, getLocationId } from "./_helpers.js";
import { query } from "../../db.js";
import { sendSms } from "../../services/channels/sms.js";
import { ensureExternalId, findByExternalId, findByAnyId, publicId } from "../../services/external-ids.js";
import { logger } from "../../services/logger.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Onda F — Conversazioni clone: lista thread + messaggi con type/direction.
// Contratto shape: docs/API_CLONE_MASTER_PLAN.md §5 onda F.
// ─────────────────────────────────────────────────────────────────────────

// Serializza una conversazione per la lista target.
// id/contactId: preferisce il ghl_id reale (parity con GHL), ricade
// sull'UUID interno per thread/contatti mai sincronizzati da/verso GHL —
// stesso pattern doppio-id già applicato a contatti/opportunità/calendari.
async function serializeThread(row, locationId) {
  const messageType = row.message_type || mapChannelToType(row.channel);
  const generatedExtId = await ensureExternalId("conversations", row.id);
  const id = publicId(row) || generatedExtId;
  const contactId = publicId({ ghl_id: row.contact_ghl_id, external_id: row.contact_external_id });
  return {
    id,
    locationId,
    contactId,
    lastMessageBody: row.last_message_body || "",
    lastMessageDate: row.last_message_date ? new Date(row.last_message_date).toISOString() : null,
    type: messageType,
    unreadCount: row.unread_count || 0,
    starred: row.starred || false,
    inbox: true,
    dateAdded: new Date(row.created_at).toISOString(),
  };
}

// Serializza un messaggio per la lista target.
// NOTA doppio-id: conversation_messages non ha una colonna ghl_id (schema
// diverso da conversations) — il suo id verso il CRM sorgente è
// source_message_id. Qui esponiamo comunque quell'id reale quando presente
// (parity in OUTPUT); l'accettazione in INPUT (startAfterId cursore,
// lookup per id) resta invece UUID-only in questo round, per il motivo di
// scoping multi-tenant spiegato in SPIEGAZIONE.txt.
async function serializeMessage(row) {
  const messageType = row.message_type || mapChannelToType(row.channel);
  const generatedMsgId = await ensureExternalId("conversation_messages", row.id);
  const msgId = (row.source_message_id && String(row.source_message_id).trim()) || row.external_id || generatedMsgId;
  const generatedConvId = await ensureExternalId("conversations", row.conversation_id);
  const convId = publicId({ ghl_id: row.conversation_ghl_id, external_id: row.conversation_external_id }) || generatedConvId;
  return {
    id: msgId,
    conversationId: convId,
    body: row.body || "",
    direction: mapDirection(row.direction),
    type: messageType,
    status: row.status || mapDirectionToStatus(row.direction),
    dateAdded: new Date(row.created_at).toISOString(),
  };
}

function mapChannelToType(channel) {
  const map = { email: "Email", whatsapp: "WhatsApp", sms: "SMS" };
  return map[channel] || "Email";
}

function mapDirection(dbDirection) {
  return dbDirection === "in" ? "inbound" : "outbound";
}

function mapDirectionToStatus(dbDirection) {
  return dbDirection === "in" ? "delivered" : "sent";
}

async function getOrUpsertContact(siteId, contactIdOrEmail) {
  let contact = null;
  let contactId = null;

  if (typeof contactIdOrEmail === "string" && contactIdOrEmail.trim() && !contactIdOrEmail.includes("@")) {
    contact = await findByAnyId("contacts", siteId, contactIdOrEmail);
    if (!contact) {
      throw new Error("Contatto non trovato");
    }
    contactId = contact.id;
  } else if (typeof contactIdOrEmail === "string" && contactIdOrEmail.includes("@")) {
    const normalized = contactIdOrEmail.trim().toLowerCase();
    const result = await query(
      "SELECT id, external_id FROM contacts WHERE site_id = $1 AND email = $2",
      [siteId, normalized]
    );
    if (result.rows[0]) {
      contact = result.rows[0];
      contactId = contact.id;
    } else {
      const newResult = await query(
        "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
        [siteId, normalized]
      );
      contact = newResult.rows[0];
      contactId = contact.id;
      if (!contact.external_id) {
        contact.external_id = await ensureExternalId("contacts", contactId);
      }
    }
  }

  if (!contact || !contactId) {
    throw new Error("Contatto non trovato o email non valida");
  }

  return { contact, contactId };
}

// GET /conversations?type=?&contactId=?&starred=?&limit&startAfterId
router.get("/conversations", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);

    let where = "c.site_id = $1";
    const params = [req.tenant.siteId];

    if (req.query.type) {
      const typeFilter = mapTypeToChannels(req.query.type);
      if (typeFilter.length > 0) {
        params.push(typeFilter);
        where += ` AND c.channel = ANY($${params.length}::text[])`;
      }
    }

    if (req.query.contactId) {
      const contactRow = await findByAnyId("contacts", req.tenant.siteId, req.query.contactId);
      if (contactRow) {
        params.push(contactRow.email);
        where += ` AND c.contact_email = $${params.length}`;
      } else {
        return sendList(res, "conversations", { conversation: [] }, 0, null);
      }
    }

    if (req.query.starred === "true") {
      params.push(true);
      where += ` AND c.starred = $${params.length}`;
    }

    // Cursor-based pagination
    if (startAfterId) {
      const cursorRow = await findByAnyId("conversations", req.tenant.siteId, startAfterId);
      if (cursorRow) {
        params.push(cursorRow.id);
        where += ` AND c.id < $${params.length}`;
      }
    }

    const countResult = await query(`SELECT COUNT(*) as total FROM conversations c WHERE ${where}`, params);
    const total = parseInt(countResult.rows[0]?.total || 0, 10);

    const results = await query(
      `SELECT c.*,
              COALESCE(
                (SELECT body FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
                ''
              ) AS last_message_body,
              COALESCE(
                (SELECT created_at FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
                c.created_at
              ) AS last_message_date,
              ct.external_id AS contact_external_id,
              ct.ghl_id AS contact_ghl_id,
              COALESCE(cm.message_type, '') AS message_type
       FROM conversations c
       LEFT JOIN contacts ct ON ct.email = c.contact_email AND ct.site_id = c.site_id
       LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
       WHERE ${where}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $${params.length + 1}`,
      [...params, limit + 1]
    );

    let nextStartAfterId = null;
    let conversations = results.rows.slice(0, limit);
    if (results.rows.length > limit) {
      const cursorNextRow = results.rows[limit];
      const generatedNextId = await ensureExternalId("conversations", cursorNextRow.id);
      nextStartAfterId = publicId(cursorNextRow) || generatedNextId;
    }

    const serialized = await Promise.all(
      conversations.map((row) => serializeThread(row, locationId))
    );

    res.json({
      conversations: {
        conversation: serialized,
      },
      meta: {
        total,
        nextPage: nextStartAfterId ? String(nextStartAfterId) : null,
        prevPage: null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /conversations/messages {type, contactId|email, message|body}
router.post("/conversations/messages", async (req, res, next) => {
  try {
    const { type, contactId, email, message, body } = req.body;
    const msgBody = message || body || "";

    if (!type || !msgBody) {
      return sendError(res, 400, "type e message/body obbligatori");
    }

    const contact = await getOrUpsertContact(req.tenant.siteId, contactId || email);
    const channel = mapTypeToChannel(type);

    if (!channel) {
      return sendError(res, 400, "type non supportato (SMS|Email|WhatsApp|LiveChat|Call)");
    }

    // Ottieni o crea thread
    const convResult = await query(
      `INSERT INTO conversations (site_id, contact_email, channel, subject)
       VALUES ($1, $2, $3, '')
       ON CONFLICT (site_id, contact_email, channel) DO UPDATE SET updated_at = NOW()
       RETURNING id, ghl_id, external_id`,
      [req.tenant.siteId, contact.contact.email, channel]
    );
    const convRow = convResult.rows[0];
    const conversationId = convRow.id;

    // Crea messaggio outbound
    const msgResult = await query(
      `INSERT INTO conversation_messages (conversation_id, direction, body, message_type, status)
       VALUES ($1, 'out', $2, $3, $4)
       RETURNING *`,
      [conversationId, msgBody, mapTypeToMessageType(type), "sent"]
    );
    const msg = msgResult.rows[0];

    // Invia SMS se SMS
    if (type === "SMS") {
      try {
        const phone = normalizePhone(contact.contact.phone || contact.contact.email);
        const result = await sendSms(req.tenant.siteId, phone, msgBody);
        await query(
          "UPDATE conversation_messages SET status = $1 WHERE id = $2",
          [result.status, msg.id]
        );
      } catch (err) {
        logger.error(`Errore invio SMS: ${err.message}`);
        return sendError(res, 502, `Errore invio SMS: ${err.message}`);
      }
    }

    const serialized = await serializeMessage({
      ...msg,
      conversation_id: conversationId,
      conversation_ghl_id: convRow.ghl_id,
      conversation_external_id: convRow.external_id,
      channel,
    });

    res.status(201).json({ message: serialized });
  } catch (err) {
    if (err.message.includes("Contatto")) {
      return sendError(res, 400, err.message);
    }
    next(err);
  }
});

// GET /conversations/:conversationId/messages?limit&startAfterId
router.get("/conversations/:conversationId/messages", async (req, res, next) => {
  try {
    const convId = requireAnyId(req.params.conversationId, res);
    if (!convId) return;

    const conv = await findByAnyId("conversations", req.tenant.siteId, convId);
    if (!conv) {
      return sendError(res, 404, "Conversazione non trovata");
    }

    const { limit, startAfterId } = getPaging(req.query);

    let where = "conversation_id = $1";
    const params = [conv.id];

    if (startAfterId) {
      const cursorMsg = await findByExternalId("conversation_messages", startAfterId);
      if (cursorMsg) {
        params.push(cursorMsg.id);
        where += ` AND id < $${params.length}`;
      }
    }

    const countResult = await query(`SELECT COUNT(*) as total FROM conversation_messages WHERE conversation_id = $1`, [conv.id]);
    const total = parseInt(countResult.rows[0]?.total || 0, 10);

    const results = await query(
      `SELECT *, $2::int AS channel_param FROM conversation_messages
       WHERE ${where}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length + 1}`,
      [...params, limit + 1]
    );

    let nextStartAfterId = null;
    let messages = results.rows.slice(0, limit);
    if (results.rows.length > limit) {
      nextStartAfterId = await ensureExternalId("conversation_messages", results.rows[limit].id);
    }

    const serialized = await Promise.all(
      messages.map((row) => serializeMessage({
        ...row,
        conversation_id: conv.id,
        conversation_ghl_id: conv.ghl_id,
        conversation_external_id: conv.external_id,
        channel: conv.channel,
      }))
    );

    res.json({
      messages: serialized,
      meta: {
        total,
        nextPage: nextStartAfterId ? String(nextStartAfterId) : null,
        prevPage: null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /conversations/:conversationId/star {starred}
router.put("/conversations/:conversationId/star", async (req, res, next) => {
  try {
    const convId = requireAnyId(req.params.conversationId, res);
    if (!convId) return;

    const conv = await findByAnyId("conversations", req.tenant.siteId, convId);
    if (!conv) {
      return sendError(res, 404, "Conversazione non trovata");
    }

    const { starred } = req.body;
    if (typeof starred !== "boolean") {
      return sendError(res, 400, "starred deve essere boolean");
    }

    await query("UPDATE conversations SET starred = $1 WHERE id = $2", [starred, conv.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /conversations/:conversationId/read
router.put("/conversations/:conversationId/read", async (req, res, next) => {
  try {
    const convId = requireAnyId(req.params.conversationId, res);
    if (!convId) return;

    const conv = await findByAnyId("conversations", req.tenant.siteId, convId);
    if (!conv) {
      return sendError(res, 404, "Conversazione non trovata");
    }

    // Marca come letto tutti i messaggi inbound
    await query(
      "UPDATE conversation_messages SET read_at = NOW() WHERE conversation_id = $1 AND direction = 'in' AND read_at IS NULL",
      [conv.id]
    );

    // Azzera unread_count
    await query("UPDATE conversations SET unread_count = 0 WHERE id = $1", [conv.id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /conversations/:conversationId/unread
router.put("/conversations/:conversationId/unread", async (req, res, next) => {
  try {
    const convId = requireAnyId(req.params.conversationId, res);
    if (!convId) return;

    const conv = await findByAnyId("conversations", req.tenant.siteId, convId);
    if (!conv) {
      return sendError(res, 404, "Conversazione non trovata");
    }

    // Inverso di /read: riporta i messaggi inbound in stato non letto
    await query(
      "UPDATE conversation_messages SET read_at = NULL WHERE conversation_id = $1 AND direction = 'in' AND read_at IS NOT NULL",
      [conv.id]
    );

    // Ripristina unread_count col numero di messaggi inbound non letti
    await query(
      "UPDATE conversations SET unread_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = $1 AND direction = 'in' AND read_at IS NULL) WHERE id = $1",
      [conv.id]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Helper mapping
// ─────────────────────────────────────────────────────────────────────────

function mapTypeToChannel(type) {
  const map = { SMS: "sms", Email: "email", WhatsApp: "whatsapp", LiveChat: "livechat", Call: "call" };
  return map[type] || null;
}

function mapTypeToChannels(type) {
  const map = { SMS: ["sms"], Email: ["email"], WhatsApp: ["whatsapp"], LiveChat: ["livechat"], Call: ["call"] };
  return map[type] || [];
}

function mapTypeToMessageType(type) {
  return type; // SMS, Email, WhatsApp, LiveChat, Call rimangono così
}

function normalizePhone(phoneOrEmail) {
  if (!phoneOrEmail) return "";
  // Se è un'email, estrai il numero dalla parte local (es. 3501234567@sms.local → 3501234567)
  if (phoneOrEmail.includes("@")) {
    const local = phoneOrEmail.split("@")[0];
    return local.replace(/\D/g, ""); // solo numeri
  }
  return phoneOrEmail.replace(/\D/g, "");
}

function sendList(res, key, value, total, nextPage) {
  const envelope = key === "conversations"
    ? { conversations: value, meta: { total, nextPage, prevPage: null } }
    : { [key]: value, meta: { total, nextPage, prevPage: null } };
  res.json(envelope);
}

export default router;
