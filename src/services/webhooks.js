import crypto from "crypto";
import { query } from "../db.js";
import { safeFetch } from "./ssrf.js";
import { logger } from "./logger.js";
import { upsertContact, addContactTag } from "./contacts.js";
import { createTask } from "./tasks.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 35 — Webhook IN/OUT per collegare n8n e automazioni esterne.
//
// OUT: enqueueForEvent() accoda una delivery per ogni webhook OUT attivo
// del sito che inoltra quell'event_type; deliverPending() le spedisce con
// firma HMAC-SHA256 (X-Webhook-Signature), timeout 10s e retry con backoff
// esponenziale (2^attempts minuti, max 5 tentativi → failed).
//
// IN: handleIncoming() riceve eventi esterni (endpoint pubblico con token)
// e applica il mapping {event_type: {action, config}} del webhook.
//
// events.js importa QUESTO modulo dinamicamente (nessun ciclo statico);
// qui events.js viene importato dinamicamente solo dentro l'azione
// emit_event, con la stessa convenzione del resto del codice.
// ─────────────────────────────────────────────────────────────────────────

const DIRECTIONS = new Set(["in", "out"]);
const MAX_EVENTS = 100;
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 10000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sanitizeWebhookData(siteId, data = {}) {
  const direction = DIRECTIONS.has(data.direction) ? data.direction : "out";
  const name = String(data.name ?? "").trim().slice(0, 255);
  if (!name) throw httpError(400, "Nome obbligatorio");

  const url = String(data.url ?? "").trim().slice(0, 2000);
  if (direction === "out" && !/^https?:\/\//i.test(url)) {
    throw httpError(400, "URL http/https obbligatorio per webhook out");
  }
  const secret = String(data.secret ?? "").slice(0, 255);

  let events = data.events;
  if (Array.isArray(events)) {
    const list = events
      .map((e) => String(e).trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, MAX_EVENTS);
    if (direction === "in") {
      // Per gli IN un array è accettato come scorciatoia: ogni chiave
      // ri-emette l'evento nel bus interno.
      const mapping = {};
      for (const e of list) mapping[e] = { action: "emit_event" };
      events = mapping;
    } else {
      events = list;
    }
  } else if (events && typeof events === "object") {
    // Mapping IN già pronto (o events errato su un OUT → ne prende le chiavi).
    const mapping = {};
    for (const [k, v] of Object.entries(events).slice(0, MAX_EVENTS)) {
      if (v && typeof v === "object") mapping[k] = v;
      else mapping[k] = { action: String(v || "emit_event") };
    }
    events = direction === "in" ? mapping : Object.keys(mapping);
  } else {
    events = direction === "in" ? {} : [];
  }
  if (direction === "out" && (!Array.isArray(events) || events.length === 0)) {
    throw httpError(400, "Almeno un evento da inoltrare");
  }

  return { site_id: siteId, direction, name, url, secret, events, active: data.active !== false };
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export async function listWebhooks(siteId, { direction = null } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (direction === "in" || direction === "out") {
    params.push(direction);
    where += ` AND direction = $${params.length}`;
  }
  const rows = (await query(
    `SELECT * FROM webhooks WHERE ${where} ORDER BY created_at DESC`,
    params
  )).rows;
  return rows;
}

export async function getWebhook(siteId, id) {
  const row = (await query(
    "SELECT * FROM webhooks WHERE id = $1 AND site_id = $2",
    [id, siteId]
  )).rows[0];
  return row || null;
}

export async function createWebhook(siteId, data) {
  const clean = sanitizeWebhookData(siteId, data);
  const result = await query(
    `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [clean.site_id, clean.name, clean.direction, clean.url, clean.secret, JSON.stringify(clean.events), clean.active]
  );
  return result.rows[0];
}

export async function updateWebhook(siteId, id, data) {
  const current = await getWebhook(siteId, id);
  if (!current) return null;
  const clean = sanitizeWebhookData(siteId, { ...current, ...data });
  const result = await query(
    `UPDATE webhooks SET name = $1, direction = $2, url = $3, secret = $4,
       events = $5, active = $6, updated_at = NOW()
     WHERE id = $7 AND site_id = $8 RETURNING *`,
    [clean.name, clean.direction, clean.url, clean.secret, JSON.stringify(clean.events), clean.active, id, siteId]
  );
  return result.rows[0];
}

export async function deleteWebhook(siteId, id) {
  const result = await query(
    "DELETE FROM webhooks WHERE id = $1 AND site_id = $2 RETURNING id",
    [id, siteId]
  );
  return result.rows[0] || null;
}

// ── OUT: accodamento + delivery ──────────────────────────────────────────

// Accoda una delivery per ogni webhook OUT attivo del sito che inoltra
// `eventType`. Fire-and-forget: le INSERT sono isolate, un errore non
// blocca mai il chiamante (che è comunque il flusso eventi).
export async function enqueueForEvent(siteId, eventType, payload = {}) {
  if (!siteId || !eventType) return { queued: 0 };
  const rows = (await query(
    `SELECT id FROM webhooks
     WHERE site_id = $1 AND direction = 'out' AND active = true
       AND events @> $2::jsonb`,
    [siteId, JSON.stringify([String(eventType)])]
  )).rows;
  if (rows.length === 0) return { queued: 0 };

  let queued = 0;
  for (const w of rows) {
    try {
      await query(
        `INSERT INTO webhook_deliveries (webhook_id, site_id, event_type, payload)
         VALUES ($1, $2, $3, $4)`,
        [w.id, siteId, String(eventType).slice(0, 100), JSON.stringify(payload || {})]
      );
      queued++;
    } catch (err) {
      logger.error(`webhook enqueue fallito (webhook=${w.id}, ${eventType}): ${err.message}`);
    }
  }
  return { queued };
}

async function recordDeliveryFailure(delivery, error) {
  const attempts = (delivery.attempts || 0) + 1;
  const lastError = String(error || "errore sconosciuto").slice(0, 500);
  if (attempts >= MAX_ATTEMPTS) {
    await query(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = $1, last_error = $2
       WHERE id = $3`,
      [attempts, lastError, delivery.id]
    );
  } else {
    const minutes = Math.pow(2, attempts); // backoff esponenziale 2^attempts
    await query(
      `UPDATE webhook_deliveries SET attempts = $1, last_error = $2,
         next_attempt_at = NOW() + make_interval(mins => $3)
       WHERE id = $4`,
      [attempts, lastError, minutes, delivery.id]
    );
  }
}

// Spedisce fino a `limit` delivery pending con next_attempt_at <= NOW().
// Con { siteId } filtra per sito (endpoint agent); senza, run globale.
// { allowPrivate } è SOLO per i test con server HTTP locali: di default il
// fetch passa da safeFetch (ssrf.js) che blocca IP privati/loopback/link-local
// (difesa in profondità per i webhook out, fix CORREZIONI-TRACCIATE).
export async function deliverPending(limit = 50, { siteId = null, allowPrivate = false } = {}) {
  const params = [];
  let where = "d.status = 'pending' AND d.next_attempt_at <= NOW()";
  if (siteId) {
    params.push(siteId);
    where += ` AND d.site_id = $${params.length}`;
  }
  params.push(Math.min(parseInt(limit, 10) || 50, 200));
  const rows = (await query(
    `SELECT d.id, d.webhook_id, d.site_id, d.event_type, d.payload, d.attempts,
            w.url, w.secret
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE ${where}
     ORDER BY d.created_at ASC
     LIMIT $${params.length}`,
    params
  )).rows;

  let delivered = 0;
  let failed = 0;
  for (const delivery of rows) {
    try {
      const body = JSON.stringify({ event_type: delivery.event_type, payload: delivery.payload });
      const headers = {
        "Content-Type": "application/json",
        "X-Webhook-Event": delivery.event_type,
      };
      if (delivery.secret) {
        headers["X-Webhook-Signature"] = crypto
          .createHmac("sha256", delivery.secret)
          .update(body)
          .digest("hex");
      }
      const res = await safeFetch(delivery.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        allowPrivate,
      });
      if (res.ok) {
        await query(
          `UPDATE webhook_deliveries SET status = 'sent', attempts = attempts + 1,
             last_error = '', next_attempt_at = NOW()
           WHERE id = $1`,
          [delivery.id]
        );
        delivered++;
      } else {
        await recordDeliveryFailure(delivery, `HTTP ${res.status}`);
        failed++;
      }
    } catch (err) {
      await recordDeliveryFailure(delivery, err.message);
      failed++;
    }
  }

  const remainingParams = siteId ? [siteId] : [];
  const remainingWhere = siteId ? " AND site_id = $1" : "";
  const remaining = (await query(
    `SELECT COUNT(*)::int AS n FROM webhook_deliveries
     WHERE status = 'pending' AND next_attempt_at <= NOW()${remainingWhere}`,
    remainingParams
  )).rows[0].n;

  return { delivered, failed, remaining };
}

// ── IN: ricezione eventi esterni ─────────────────────────────────────────

// Trova il webhook IN attivo per token e applica il mapping. Ritorna null
// (→ 401) se il token non corrisponde a nessun webhook attivo del sito.
export async function handleIncoming(siteId, token, body = {}) {
  const webhook = (await query(
    `SELECT * FROM webhooks
     WHERE site_id = $1 AND direction = 'in' AND active = true AND secret = $2`,
    [siteId, String(token || "")]
  )).rows[0];
  if (!webhook) return null;

  let mapping = webhook.events;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) mapping = {};

  const eventType = String(body.event_type || body.type || "").trim();
  let actions = 0;
  if (eventType && mapping[eventType]) {
    actions += await runInboundAction(siteId, eventType, mapping[eventType], body, webhook.id);
  } else {
    // Senza event_type (o non mappato) si usa la prima chiave del mapping.
    const firstKey = Object.keys(mapping)[0];
    if (firstKey) {
      actions += await runInboundAction(siteId, firstKey, mapping[firstKey], body, webhook.id);
    }
  }
  return { received: true, actions };
}

async function runInboundAction(siteId, eventType, rule, body, webhookId) {
  if (!rule || typeof rule !== "object") return 0;
  const action = String(rule.action || "");
  const config = rule.config || {};
  const email = String(body.email || body.contact?.email || "").trim().toLowerCase();
  try {
    switch (action) {
      case "create_contact": {
        if (!email) return 0;
        await upsertContact(siteId, email);
        const tags = Array.isArray(config.tags) ? config.tags : (Array.isArray(body.tags) ? body.tags : []);
        for (const tag of tags) await addContactTag(siteId, email, tag);
        return 1;
      }
      case "emit_event": {
        if (!email) return 0;
        const { emitContactEvent } = await import("./events.js");
        await emitContactEvent(
          siteId,
          email,
          String(config.event_type || "webhook").slice(0, 100),
          { webhook_id: webhookId, event_type: eventType, ...(body || {}) }
        );
        return 1;
      }
      case "add_tag": {
        if (!email || !config.tag) return 0;
        await addContactTag(siteId, email, config.tag);
        return 1;
      }
      case "create_task": {
        await createTask(siteId, {
          title: String(config.title || "Task da webhook").slice(0, 255),
          email,
          notes: String(config.notes || "").slice(0, 2000),
          dueAt: config.due_at ? new Date(config.due_at) : null,
        });
        return 1;
      }
      default:
        logger.warn(`webhook in: azione sconosciuta '${action}' (webhook=${webhookId})`);
        return 0;
    }
  } catch (err) {
    logger.error(`webhook in azione fallita (${action}, site=${siteId}): ${err.message}`);
    return 0;
  }
}
