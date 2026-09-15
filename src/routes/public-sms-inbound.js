import { Router } from "express";
import { query } from "../db.js";
import { ensureExternalId } from "../services/external-ids.js";
import { logger } from "../services/logger.js";

const router = Router();

// Onda F — Inbound SMS webhook pubblico: riceve messaggi da provider SMS
// (Twilio, ecc.), valida il token e registra il messaggio nel thread.
// Risponde SEMPRE 200 per non far riprovare il provider (fire-and-forget).

async function validateToken(siteId, token) {
  const result = await query(
    `SELECT id FROM webhooks
     WHERE site_id = $1 AND direction = 'in' AND active = true AND secret = $2 LIMIT 1`,
    [siteId, token]
  );
  return result.rows.length > 0;
}

async function upsertContact(siteId, phone) {
  // Email sintetica: {numero_pulito}@sms.local
  // Mantiene la mapping stable per inbound/outbound su stesso numero
  const normalized = phone.replace(/\D/g, "");
  const syntheticEmail = `${normalized}@sms.local`;

  let contact = await query(
    "SELECT id, external_id FROM contacts WHERE site_id = $1 AND email = $2",
    [siteId, syntheticEmail]
  );

  if (contact.rows[0]) {
    return { id: contact.rows[0].id, external_id: contact.rows[0].external_id };
  }

  const newResult = await query(
    "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
    [siteId, syntheticEmail]
  );

  const c = newResult.rows[0];
  if (!c.external_id) {
    c.external_id = await ensureExternalId("contacts", c.id);
  }
  return c;
}

async function getOrCreateConversation(siteId, contactEmail) {
  const result = await query(
    `INSERT INTO conversations (site_id, contact_email, channel, subject)
     VALUES ($1, $2, 'sms', '')
     ON CONFLICT (site_id, contact_email, channel) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [siteId, contactEmail]
  );
  return result.rows[0].id;
}

router.post("/webhooks/sms/:siteId/:token", async (req, res) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const token = String(req.params.token || "");

    if (!Number.isInteger(siteId) || siteId < 1 || !token) {
      logger.warn(`Webhook SMS: siteId o token non validi`);
      return res.status(200).json({ ok: true });
    }

    // Valida il token
    const valid = await validateToken(siteId, token);
    if (!valid) {
      logger.warn(`Webhook SMS: token non riconosciuto per site ${siteId}`);
      return res.status(200).json({ ok: true });
    }

    // Estrai payload (Twilio usa FormUrlEncoded per impostazione)
    const { from, to, body, Body } = req.body;
    const msgBody = body || Body || "";
    const fromPhone = from || "";

    if (!fromPhone || !msgBody) {
      logger.warn(`Webhook SMS: from o body mancanti`);
      return res.status(200).json({ ok: true });
    }

    // Upsert contatto con email sintetica
    const contact = await upsertContact(siteId, fromPhone);

    // Ottieni o crea conversazione SMS
    const conversationId = await getOrCreateConversation(siteId, contact.email || `${fromPhone.replace(/\D/g, "")}@sms.local`);

    // Inserisci messaggio inbound
    const msgResult = await query(
      `INSERT INTO conversation_messages (conversation_id, direction, body, message_type, status, read_at)
       VALUES ($1, 'in', $2, 'SMS', 'delivered', NULL)
       RETURNING id`,
      [conversationId, msgBody]
    );

    // Incrementa unread_count
    await query(
      "UPDATE conversations SET unread_count = unread_count + 1 WHERE id = $1",
      [conversationId]
    );

    logger.info(`SMS inbound registrato: conversation=${conversationId} contact=${contact.id} msg_len=${msgBody.length}`);

    // Emetti evento CRM se disponibile
    try {
      const { emitContactEvent } = await import("../services/events.js");
      const contactEmail = contact.email || `${fromPhone.replace(/\D/g, "")}@sms.local`;
      emitContactEvent(siteId, contactEmail, "sms_received", {
        from_phone: fromPhone,
        conversation_id: conversationId,
      }).catch((err) => logger.error(`Errore emit SMS event: ${err.message}`));
    } catch (err) {
      logger.debug(`Events non disponibili: ${err.message}`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error(`Errore webhook SMS: ${err.message}`);
    // Risponde 200 ugualmente per non far riprovare il provider
    res.status(200).json({ ok: true });
  }
});

export default router;
