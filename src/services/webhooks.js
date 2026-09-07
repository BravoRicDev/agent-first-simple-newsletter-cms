import crypto from "crypto";
import { query, getClient } from "../db.js";
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
// CLUSTER (Active/Active): deliverPending() è "single-fire": usa un advisory
// lock globale + claim atomico (FOR UPDATE SKIP LOCKED → status 'sending').
// In ogni finestra UN SOLO nodo svuota l'outbox e due nodi non spediscono
// mai la stessa delivery (evita l'innesco multiplo della stessa automazione,
// es. verso GoHighLevel). `origin` traccia da dove nasce l'evento
// ('cms'|'agent'|'ghl_in'|'import') per l'anti-echo del push GHL.
//
// IN: handleIncoming() riceve eventi esterni (endpoint pubblico con token)
// e applica il mapping {event_type: {action, config}} del webhook.
//
// WEBHOOK OUT ENRICHMENT: prima della delivery, arricchisce il payload
// con i dati completi del contatto e/o opportunità (incluse custom fields).
// ─────────────────────────────────────────────────────────────────────────

const DIRECTIONS = new Set(["in", "out"]);
const MAX_EVENTS = 100;
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 10000;
// Chiave del lock globale "un solo nodo svuota l'outbox alla volta".
const WEBHOOK_DELIVER_LOCK_KEY = 74812001;

const VALID_ORIGINS = new Set(["cms", "agent", "ghl_in", "import"]);

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
  // Webhook IN: il `secret` è il TOKEN nel path pubblico (/webhooks/in/:token):
  // senza una soglia minima di entropia un segreto debole/riusato espone
  // scritture non autenticate (create_contact/add_tag/create_task). Minimo
  // 24 char — le installazioni esistenti non vengono toccate (questo check
  // scatta solo in create/update).
  if (direction === "in" && secret.length < 24) {
    throw httpError(400, "Secret del webhook IN: minimo 24 caratteri");
  }

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

  let filter = {};
  if (data.filter && typeof data.filter === "object" && !Array.isArray(data.filter)) {
    filter = Object.fromEntries(
      Object.entries(data.filter)
        .slice(0, 20)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [String(k).slice(0, 100), typeof v === "object" ? JSON.stringify(v) : String(v).slice(0, 500)])
    );
  }

  // Allowlist IP sorgente (solo IN): array di CIDR/IP, validati in modo lasco.
  let allowed_ips = [];
  if (Array.isArray(data.allowed_ips)) {
    allowed_ips = data.allowed_ips
      .map((v) => String(v).trim().slice(0, 100))
      .filter((v) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(v))
      .slice(0, 20);
  }
  // Chiave di verifica HMAC (solo IN): separata dal token del path.
  const verify_secret = String(data.verify_secret ?? "").slice(0, 255);

  // Template payload OUT (mustache-like) per personalizzare il body inviato.
  let payload_template = {};
  if (data.payload_template && typeof data.payload_template === "object" && !Array.isArray(data.payload_template)) {
    payload_template = Object.fromEntries(
      Object.entries(data.payload_template)
        .slice(0, 50)
        .map(([k, v]) => [String(k).slice(0, 100), v])
    );
  } else if (typeof data.payload_template === "string" && data.payload_template.trim()) {
    // Accetta anche un JSON string per comodità da UI/agent.
    try {
      const parsed = JSON.parse(data.payload_template);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload_template = parsed;
    } catch {
      payload_template = {};
    }
  }

  return { site_id: siteId, direction, name, url, secret, events, filter, allowed_ips, verify_secret, payload_template, active: data.active !== false };
}

// ── Sicurezza INBOUND ───────────────────────────────────────────────────────

// Verifica che un IP (IPv4/IPv6) appartenga a uno dei CIDR/IP consentiti.
export function ipInAllowedList(ipStr, allowedIps) {
  if (!allowedIps || !Array.isArray(allowedIps) || allowedIps.length === 0) return true;
  if (!ipStr) return false;
  for (const cidr of allowedIps) {
    if (cidr === ipStr) return true;
    // Simple CIDR check (IPv4 and IPv6)
    const [rangeIp, bits] = String(cidr).includes("/") ? cidr.split("/") : [cidr, null];
    if (bits) {
      const bitsNum = parseInt(bits, 10);
      if (isNaN(bitsNum)) continue;
      if (cidrMatch(ipStr, rangeIp, bitsNum)) return true;
    }
  }
  return false;
}

function cidrMatch(ip, rangeIp, bits) {
  // Simple CIDR matching for both IPv4 and IPv6
  // For production use a proper library, but this covers common cases
  try {
    const ipParts = ip.split(":").map(p => parseInt(p, 16));
    const rangeParts = rangeIp.split(":").map(p => parseInt(p, 16));
    if (ipParts.length !== rangeParts.length) return false;
    const totalBits = ipParts.length * 16;
    const bytes = Math.floor(bits / 8);
    const remainingBits = bits % 8;
    for (let i = 0; i < bytes; i++) {
      if (ipParts[i] !== rangeParts[i]) return false;
    }
    if (remainingBits > 0) {
      const mask = 0xFF << (8 - (bits % 8));
      if ((ipParts[bytes] & mask) !== (rangeParts[bytes] & mask)) return false;
    }
    return true;
  } catch {
    // Fallback to string prefix for simple cases
    return String(ipStr).startsWith(rangeIp.replace(/0+$/, "").replace(/\/$/, ""));
  }
}

// Verifica firma HMAC-SHA256 del body (X-Webhook-Signature header).
export function verifyHmacSignature(secret, body, providedSig) {
  if (!secret || !providedSig) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  // Constant-time compare
  if (providedSig.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ providedSig.charCodeAt(i);
  }
  return result === 0;
}

// Log inbound attempt in webhook_inbound_log
async function logInboundAttempt({ siteId, webhookId, eventType, ip, status, reason, requestBody, responseStatus }) {
  try {
    await query(
      `INSERT INTO webhook_inbound_log
        (site_id, webhook_id, event_type, ip, status, reason, request_body, response_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [siteId, webhookId, eventType, ip, status, reason, requestBody ? JSON.stringify(requestBody) : null, responseStatus]
    );
  } catch (err) {
    // Don't fail the request if logging fails
    logger.error(`webhook inbound log failed: ${err.message}`);
  }
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
    `INSERT INTO webhooks (site_id, name, direction, url, secret, events, filter, allowed_ips, verify_secret, payload_template, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [clean.site_id, clean.name, clean.direction, clean.url, clean.secret, JSON.stringify(clean.events), JSON.stringify(clean.filter), JSON.stringify(clean.allowed_ips), clean.verify_secret, JSON.stringify(clean.payload_template), clean.active]
  );
  return result.rows[0];
}

export async function updateWebhook(siteId, id, data) {
  const current = await getWebhook(siteId, id);
  if (!current) return null;
  const clean = sanitizeWebhookData(siteId, { ...current, ...data });
  const result = await query(
    `UPDATE webhooks SET name = $1, direction = $2, url = $3, secret = $4,
       events = $5, filter = $6, allowed_ips = $7, verify_secret = $8, payload_template = $9, active = $10, updated_at = NOW()
     WHERE id = $11 AND site_id = $12 RETURNING *`,
    [clean.name, clean.direction, clean.url, clean.secret, JSON.stringify(clean.events), JSON.stringify(clean.filter), JSON.stringify(clean.allowed_ips), clean.verify_secret, JSON.stringify(clean.payload_template), clean.active, id, siteId]
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

// Verifica che un payload soddisfi le condizioni del filtro del webhook.
// Semantica AND: ogni chiave del filtro deve matchare il payload.
// Valore con prefisso '!' → il payload NON deve essere uguale.
// Le chiavi possono essere dot-path (es. "contact.email", "payload.to_stage").
export function matchesFilter(filter, payload) {
  if (!filter || typeof filter !== "object" || Object.keys(filter).length === 0) return true;
  const getPath = (obj, path) => {
    const parts = String(path).split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[p];
    }
    return cur;
  };
  for (const [key, expected] of Object.entries(filter)) {
    const negative = String(expected).startsWith("!");
    const value = negative ? String(expected).slice(1) : String(expected);
    const actual = getPath(payload, key);
    const matches = String(actual === undefined || actual === null ? "" : actual) === value;
    if (negative && matches) return false;
    if (!negative && !matches) return false;
  }
  return true;
}

// ── Payload templating ──────────────────────────────────────────────────
// Semplice motore di template mustache-like: {{field.path}} viene sostituito
// col valore corrispondente nell'oggetto dati (dot-notation).
// Es. template '{"name": "{{contact.name}}", "stage": "{{opportunity.stage}}"}'
//     data = { contact: {name: "Mario"}, opportunity: {stage: "qualified"} }
//     → '{"name": "Mario", "stage": "qualified"}'
export function renderTemplate(template, data) {
  if (!template || typeof template !== "object" || Object.keys(template).length === 0) return template;
  if (typeof template === "string") {
    // Template string: sostituisci {{path}} con valore da data
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const parts = path.trim().split(".");
      let val = data;
      for (const p of parts) {
        if (val === null || val === undefined) return "";
        val = val[p];
      }
      return val === undefined || val === null ? "" : String(val);
    });
  }
  // Template object: renderizza ricorsivamente i valori stringa
  const rendered = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value === "string") {
      rendered[key] = value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
        const parts = path.trim().split(".");
        let val = data;
        for (const p of parts) {
          if (val === null || val === undefined) return "";
          val = val[p];
        }
        return val === undefined || val === null ? "" : String(val);
      });
    } else if (value && typeof value === "object") {
      rendered[key] = renderTemplate(value, data);
    } else {
      rendered[key] = value;
    }
  }
  return rendered;
}

// Accoda una delivery per ogni webhook OUT attivo del sito che inoltra
// `eventType`. Fire-and-forget: le INSERT sono isolate, un errore non
// blocca mai il chiamante (che è comunque il flusso eventi).
// `options.origin` ('cms'|'agent'|'ghl_in'|'import') registra da dove
// nasce l'evento (usato per l'anti-echo del push verso il CRM sorgente).
export async function enqueueForEvent(siteId, eventType, payload = {}, options = {}) {
  if (!siteId || !eventType) return { queued: 0 };
  const origin = VALID_ORIGINS.has(options.origin) ? options.origin : "cms";
  const rows = (await query(
    `SELECT id, filter FROM webhooks
     WHERE site_id = $1 AND direction = 'out' AND active = true
       AND events @> $2::jsonb`,
    [siteId, JSON.stringify([String(eventType)])]
  )).rows;
  if (rows.length === 0) return { queued: 0 };

  let queued = 0;
  let filtered = 0;
  for (const w of rows) {
    // Filtro condizioni payload: se non matcha, la delivery NON parte.
    if (!matchesFilter(w.filter, payload)) { filtered++; continue; }
    try {
      await query(
        `INSERT INTO webhook_deliveries (webhook_id, site_id, event_type, payload, origin)
         VALUES ($1, $2, $3, $4, $5)`,
        [w.id, siteId, String(eventType).slice(0, 100), JSON.stringify(payload || {}), origin]
      );
      queued++;
    } catch (err) {
      logger.error(`webhook enqueue fallito (webhook=${w.id}, ${eventType}): ${err.message}`);
    }
  }
  return { queued, filtered };
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
      `UPDATE webhook_deliveries SET status = 'pending', attempts = $1, last_error = $2,
         next_attempt_at = NOW() + make_interval(mins => $3)
       WHERE id = $4`,
      [attempts, lastError, minutes, delivery.id]
    );
  }
}

// ── WEBHOOK OUT ENRICHMENT ──────────────────────────────────────────────
//
// Arricchisce il payload di una delivery con i dati completi del contatto
// e/o opportunità (incluse custom fields) prima dell'invio.
// Lect+Quality: il payload esce con { event_type, payload } dove payload
// ora include i sub-oggetti `contact` e/o `opportunity` con dati completi.
// ─────────────────────────────────────────────────────────────────────────

const CONTACT_EVENT_TYPES = new Set([
  "contact_created", "contact_updated", "contact_deleted",
  "tag_added", "stage_changed", "custom_field_updated",
]);
const OPPORTUNITY_EVENT_TYPES = new Set([
  "opportunity_stage_changed", "opportunity_status_changed",
  "opportunity_deleted", "opportunity_created",
  "quote_sent", "quote_viewed", "quote_signed",
]);

function parsePayload(row) {
  if (!row) return {};
  const raw = row.payload;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (raw && typeof raw === "object") return raw;
  return {};
}

// Carica contatto completo + custom values (object_key='contact').
// Ritorna l'oggetto serializzato o null se non trovato (già cancellato).
async function loadFullContact(siteId, contactId) {
  const id = parseInt(contactId, 10);
  if (!Number.isFinite(id)) return null;

  const row = (await query(
    `SELECT c.*, cv.values AS custom_values
     FROM contacts c
     LEFT JOIN contact_custom_values cv
       ON cv.site_id = c.site_id AND cv.contact_id = c.id AND cv.object_key = 'contact'
     WHERE c.id = $1 AND c.site_id = $2`,
    [id, siteId]
  )).rows[0];
  if (!row) return null;

  const cv = row.custom_values
    ? (typeof row.custom_values === "string" ? JSON.parse(row.custom_values) : row.custom_values)
    : {};

  const profile = {
    name: cv.name ?? "",
    firstName: cv.firstName ?? "",
    lastName: cv.lastName ?? "",
    phone: cv.phone ?? "",
    companyName: cv.companyName ?? "",
    website: cv.website ?? "",
  };
  const custom = {};
  for (const [k, v] of Object.entries(cv)) {
    if (!["name", "firstName", "lastName", "phone", "companyName", "website"].includes(k)) {
      custom[k] = v;
    }
  }

  return {
    id: row.id,
    email: row.email,
    ...profile,
    tags: row.tags || [],
    status: row.status || "",
    notes: row.notes || "",
    value_estimate: row.value_estimate !== null && row.value_estimate !== undefined
      ? Number(row.value_estimate) : null,
    is_client: !!row.is_client,
    client_status: row.client_status || "inactive",
    customFields: custom,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Carica opportunità completa + custom values (object_key='opportunity').
// Ritorna l'oggetto serializzato o null se non trovata (già cancellata).
async function loadFullOpportunity(siteId, opportunityId) {
  const id = parseInt(opportunityId, 10);
  if (!Number.isFinite(id)) return null;

  const row = (await query(
    `SELECT o.*, p.name AS pipeline_name, ocv.values AS custom_values
     FROM opportunities o
     LEFT JOIN pipelines p ON p.id = o.pipeline_id
     LEFT JOIN opportunity_custom_values ocv
       ON ocv.site_id = o.site_id AND ocv.opportunity_id = o.id
     WHERE o.id = $1 AND o.site_id = $2`,
    [id, siteId]
  )).rows[0];
  if (!row) return null;

  const cv = row.custom_values
    ? (typeof row.custom_values === "string" ? JSON.parse(row.custom_values) : row.custom_values)
    : {};

  return {
    id: row.id,
    contactEmail: row.contact_email,
    pipeline_id: row.pipeline_id,
    pipelineName: row.pipeline_name || null,
    stage: row.stage,
    title: row.title,
    amount: row.amount !== null && row.amount !== undefined ? Number(row.amount) : 0,
    probability: row.probability,
    status: row.status,
    expectedCloseDate: row.expected_close_at,
    notes: row.notes,
    customFields: { ...(cv || {}) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Arricchisce il payload di una delivery con i dati del contatto e/o
// opportunità. Modifica delivery.payload IN-PLACE aggiungendo i campi
// `contact` e/o `opportunity` se gli ID sono presenti nel payload
// originale e i dati esistono ancora in DB.
// Per eventi di cancellazione (contact_deleted, opportunity_deleted),
// arricchisce comunque se il record esiste ancora (best-effort).
export async function enrichPayload(delivery) {
  const siteId = delivery.site_id;
  const eventType = delivery.event_type;
  let payload = parsePayload(delivery);

  const isContactEvent = CONTACT_EVENT_TYPES.has(eventType)
    || eventType.startsWith("contact_");
  const isOpportunityEvent = OPPORTUNITY_EVENT_TYPES.has(eventType)
    || eventType.startsWith("opportunity_") || eventType.startsWith("quote_");

  if (isContactEvent && payload.contact_id) {
    try {
      const contact = await loadFullContact(siteId, payload.contact_id);
      if (contact) payload.contact = contact;
    } catch (err) {
      logger.error(`webhook enrich: loadFullContact fallito (delivery=${delivery.id}): ${err.message}`);
    }
  }

  if (isOpportunityEvent && payload.opportunity_id) {
    try {
      const opportunity = await loadFullOpportunity(siteId, payload.opportunity_id);
      if (opportunity) payload.opportunity = opportunity;
    } catch (err) {
      logger.error(`webhook enrich: loadFullOpportunity fallito (delivery=${delivery.id}): ${err.message}`);
    }
  }

  // Se è un evento di contatto con email ma senza contact_id, prova a
  // risolvere il contatto per email (es. eventi legacy senza contact_id).
  if (isContactEvent && !payload.contact_id && payload.email) {
    try {
      const row = (await query(
        "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = $2",
        [siteId, String(payload.email).trim().toLowerCase()]
      )).rows[0];
      if (row) {
        const contact = await loadFullContact(siteId, row.id);
        if (contact) payload.contact = contact;
      }
    } catch (err) {
      logger.error(`webhook enrich: loadContactByEmail fallito (delivery=${delivery.id}): ${err.message}`);
    }
  }

  // Se è un evento di opportunità con contactEmail ma senza il sub-oggetto
  // contact ancora popolato, prova a caricare anche il contatto.
  if (isOpportunityEvent && payload.opportunity?.contactEmail && !payload.contact) {
    try {
      const row = (await query(
        "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = $2",
        [siteId, String(payload.opportunity.contactEmail).trim().toLowerCase()]
      )).rows[0];
      if (row) {
        const contact = await loadFullContact(siteId, row.id);
        if (contact) payload.contact = contact;
      }
    } catch (err) {
      logger.error(`webhook enrich: loadContactFromOpportunity fallito (delivery=${delivery.id}): ${err.message}`);
    }
  }

  // Salva il payload arricchito SOLO se sono stati aggiunti dati (evita
  // UPDATE inutili).
  const origStr = JSON.stringify(delivery.payload);
  const newStr = JSON.stringify(payload);
  if (newStr !== origStr) {
    delivery.payload = payload;
  }
}

// Eventi che vanno arricchiti con dati completi contatto/opportunità.
function shouldEnrich(eventType) {
  return CONTACT_EVENT_TYPES.has(eventType)
    || OPPORTUNITY_EVENT_TYPES.has(eventType)
    || eventType.startsWith("contact_")
    || eventType.startsWith("opportunity_")
    || eventType.startsWith("quote_");
}

// Spedisce fino a `limit` delivery pending con next_attempt_at <= NOW().
// Con { siteId } filtra per sito (endpoint agent); senza, run globale.
// { allowPrivate } è SOLO per i test con server HTTP locali: di default il
// fetch passa da safeFetch (ssrf.js) che blocca IP privati/loopback/link-local
// (difesa in profondità per i webhook out, fix CORREZIONI-TRACCIATE).
//
// CLUSTER single-fire: advisory lock globale (un solo nodo draina alla
// volta) + claim atomico con FOR UPDATE SKIP LOCKED (status 'sending'):
// anche due chiamate concorrenti (due nodi Active/Active) non selezionano
// mai la stessa riga → una sola delivery per evento.
export async function deliverPending(limit = 50, { siteId = null, allowPrivate = false } = {}) {
  const lockClient = await getClient();
  let locked = false;
  try {
    const lockRes = await lockClient.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [WEBHOOK_DELIVER_LOCK_KEY]
    );
    locked = lockRes.rows[0].locked;
    if (!locked) {
      // Un altro nodo/istanza sta già svuotando la coda: salta senza sprecare
      // chiamate. Le righe restano pending e verranno prese al giro successivo.
      const remainingParams = siteId ? [siteId] : [];
      const remainingWhere = siteId ? " AND site_id = $1" : "";
      const remaining = (await query(
        `SELECT COUNT(*)::int AS n FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= NOW()${remainingWhere}`,
        remainingParams
      )).rows[0].n;
      return { delivered: 0, failed: 0, remaining, skipped: true };
    }

    // Reaper: righe rimaste in 'sending' oltre 10min (processo morto durante
    // la consegna) vengono riportate a 'pending' per un nuovo tentativo.
    // Il timeout di consegna è 10s, quindi 10min non può intaccare una
    // consegna legittima in corso.
    await query(
      `UPDATE webhook_deliveries SET status = 'pending'
       WHERE status = 'sending' AND created_at < NOW() - interval '10 minutes'`
    );

    // Claim atomico: marca come 'sending' le righe selezionate (escluse da
    // qualunque altro worker), poi recupera url/secret dei webhook.
    let rows = [];
    try {
      await lockClient.query("BEGIN");
      const params = [];
      let where = "d.status = 'pending' AND d.next_attempt_at <= NOW()";
      if (siteId) {
        params.push(siteId);
        where += ` AND d.site_id = $${params.length}`;
      }
      params.push(Math.min(parseInt(limit, 10) || 50, 200));

      const claim = await lockClient.query(
        `WITH due AS (
           SELECT d.id FROM webhook_deliveries d
           WHERE ${where}
           ORDER BY d.created_at ASC
           LIMIT $${params.length}
           FOR UPDATE SKIP LOCKED
         )
         UPDATE webhook_deliveries d SET status = 'sending'
         FROM due WHERE d.id = due.id
         RETURNING d.id`,
        params
      );
      const ids = claim.rows.map((r) => r.id);
if (ids.length > 0) {
        const detail = await lockClient.query(
          `SELECT d.id, d.webhook_id, d.site_id, d.event_type, d.payload, d.attempts,
                  w.url, w.secret, w.payload_template
           FROM webhook_deliveries d
           JOIN webhooks w ON w.id = d.webhook_id
           WHERE d.id = ANY($1::int[])`,
          [ids]
        );
        rows = detail.rows;
      }
      await lockClient.query("COMMIT");
    } catch (err) {
      await lockClient.query("ROLLBACK").catch(() => {});
      throw err;
    }

    let delivered = 0;
    let failed = 0;
    for (const delivery of rows) {
      try {
        // ENRICHMENT: arricchisci il payload con dati completi contatto/opportunità
        if (shouldEnrich(delivery.event_type)) {
          await enrichPayload(delivery);
        }

        // TEMPLATE: applica il payload_template se configurato nel webhook
        if (delivery.payload_template && typeof delivery.payload_template === "object" && Object.keys(delivery.payload_template).length > 0) {
          delivery.payload = renderTemplate(delivery.payload_template, delivery.payload);
        }

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
          try { await recordDeliveryFailure(delivery, `HTTP ${res.status}`); } catch (e) {}
          failed++;
        }
      } catch (err) {
        try { await recordDeliveryFailure(delivery, err.message); } catch (e) {}
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
  } finally {
    if (locked) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [WEBHOOK_DELIVER_LOCK_KEY]);
      } catch (err) {
        logger.error(`webhook deliver: unlock fallito (la connessione verrà chiusa dal pool): ${err.message}`);
      }
    }
    lockClient.release();
  }
}

// ── Invio diretto di un payload verso un URL esterno ────────────────────
// Usato dall'azione workflow `send_webhook` e dal ping/test dei webhook OUT:
// firma HMAC-SHA256 (X-Webhook-Signature), header X-Webhook-Event, timeout
// 10s. NON scrive in webhook_deliveries (niente retry): per il retry con
// backoff restano i webhook OUT configurati, che passano da deliverPending().
export async function sendWebhookPayload({ url, secret = "", eventType = "webhook", payload = {}, allowPrivate = false } = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) {
    return { ok: false, status: 0, error: "URL http/https obbligatorio" };
  }
  const body = JSON.stringify({ event_type: eventType, payload });
  const headers = {
    "Content-Type": "application/json",
    "X-Webhook-Event": String(eventType).slice(0, 100),
  };
  if (secret) {
    headers["X-Webhook-Signature"] = crypto
      .createHmac("sha256", String(secret))
      .update(body)
      .digest("hex");
  }
  try {
    const res = await safeFetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      allowPrivate,
    });
    return { ok: res.ok, status: res.status, error: res.ok ? "" : `HTTP ${res.status}`, webhook: { url } };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, webhook: { url } };
  }
}

// ── IN: ricezione eventi esterni ─────────────────────────────────────────

// Trova il webhook IN attivo per token e applica il mapping. Ritorna null
// (→ 401) se il token non corrisponde a nessun webhook attivo del sito.
// Restituisce oggetto con: { received: bool, actions: number, rejected: string|null }
// rejected contiene motivo se respinto: 'ip_blocked' | 'signature_fail' | 'filtered'
// opts: { ip: string|null, signature: string|null } — signature = header X-Webhook-Signature
// (firma HMAC-SHA256 del body serializzato, come inviato da n8n)
export async function handleIncoming(siteId, token, body = {}, opts = {}) {
  const ip = opts?.ip || null;
  const providedSig = String(opts?.signature || "").trim();
  const webhook = (await query(
    `SELECT * FROM webhooks
     WHERE site_id = $1 AND direction = 'in' AND active = true AND secret = $2`,
    [siteId, String(token || "")]
  )).rows[0];
  if (!webhook) {
    await logInboundAttempt({ siteId, ip, status: "invalid_token", reason: "Token non valido", requestBody: body, responseStatus: 401 });
    return null;
  }

  // 1. IP allowlist check
  if (ip && webhook.allowed_ips && Array.isArray(webhook.allowed_ips) && webhook.allowed_ips.length > 0) {
    const allowed = ipInAllowedList(ip, webhook.allowed_ips);
    if (!allowed) {
      await logInboundAttempt({ siteId, webhookId: webhook.id, ip, status: "ip_blocked", reason: `IP ${ip} non in allowlist`, requestBody: body, responseStatus: 403 });
      return { received: false, actions: 0, rejected: "ip_blocked" };
    }
  }

  // 2. HMAC signature verification (header X-Webhook-Signature sul body serializzato)
  if (webhook.verify_secret) {
    const canonical = typeof body === "string" ? body : JSON.stringify(body);
    if (!providedSig) {
      await logInboundAttempt({ siteId, webhookId: webhook.id, ip, status: "signature_fail", reason: "Firma HMAC mancante", requestBody: body, responseStatus: 401 });
      return { received: false, actions: 0, rejected: "signature_fail" };
    }
    if (!verifyHmacSignature(webhook.verify_secret, canonical, providedSig)) {
      await logInboundAttempt({ siteId, webhookId: webhook.id, ip, status: "signature_fail", reason: "Firma HMAC non valida", requestBody: body, responseStatus: 401 });
      return { received: false, actions: 0, rejected: "signature_fail" };
    }
  }

  // 3. Inbound payload filter (like OUT webhooks)
  if (webhook.filter && Object.keys(webhook.filter).length > 0) {
    const payloadForFilter = body.payload || body;
    if (!matchesFilter(webhook.filter, payloadForFilter)) {
      await logInboundAttempt({ siteId, webhookId: webhook.id, ip, status: "filtered", reason: "Payload non matcha filtro", requestBody: body, responseStatus: 200 });
      return { received: true, actions: 0, rejected: "filtered" };
    }
  }

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

  await logInboundAttempt({ siteId, webhookId: webhook.id, eventType, ip, status: "accepted", reason: null, requestBody: body, responseStatus: 200 });
  return { received: true, actions, rejected: null };
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
        await upsertContact(siteId, email, { origin: "ghl_in" });
        const tags = Array.isArray(config.tags) ? config.tags : (Array.isArray(body.tags) ? body.tags : []);
        for (const tag of tags) await addContactTag(siteId, email, tag, { origin: "ghl_in" });
        return 1;
      }
      case "emit_event": {
        if (!email) return 0;
        const { emitContactEvent } = await import("./events.js");
        await emitContactEvent(
          siteId,
          email,
          String(config.event_type || "webhook").slice(0, 100),
          { webhook_id: webhookId, event_type: eventType, ...(body || {}) },
          { origin: "ghl_in" }
        );
        return 1;
      }
      case "add_tag": {
        if (!email || !config.tag) return 0;
        await addContactTag(siteId, email, config.tag, { origin: "ghl_in" });
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