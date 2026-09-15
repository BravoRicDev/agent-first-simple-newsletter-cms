import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Clienti + Servizi (area clienti GENERICA).
//
// Il CMS non sa nulla di "area clienti" specifica: espone soltanto
//   - clienti: contatti marcati `is_client` con uno stato
//     ('inactive' | 'active' | 'suspended')
//   - catalogo servizi: voci configurabili (key stabile + label)
//   - stato servizio per cliente: attivo/disattivato (+ config JSONB)
//
// Un servizio ESTERNO (area clienti dedicata, deploy separato) interrogherà
// le API agent (checkClientAccess / access-by-email) per decidere se un
// cliente può accedere a un servizio. Tutto il resto è generico.
// ─────────────────────────────────────────────────────────────────────────

export const CLIENT_STATUSES = new Set(["inactive", "active", "suspended"]);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Normalizza la chiave servizio: minuscolo, solo [a-z0-9_-], max 50.
export function normalizeServiceKey(key) {
  return String(key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 50);
}

// ── Catalogo servizi ──────────────────────────────────────────────────────

export async function listServicesCatalog() {
  const result = await query("SELECT * FROM services_catalog ORDER BY key");
  return result.rows;
}

export async function createService({ key, label, description = "" } = {}) {
  const cleanKey = normalizeServiceKey(key);
  if (!cleanKey) throw httpError(400, "Chiave servizio mancante o non valida");
  const cleanLabel = String(label || "").trim().slice(0, 100);
  if (!cleanLabel) throw httpError(400, "Label servizio obbligatoria");
  const result = await query(
    `INSERT INTO services_catalog (key, label, description)
     VALUES ($1, $2, $3) RETURNING *`,
    [cleanKey, cleanLabel, String(description || "").slice(0, 2000)]
  );
  return result.rows[0];
}

export async function updateService(key, { label, description, active } = {}) {
  const cleanKey = normalizeServiceKey(key);
  if (!cleanKey) throw httpError(400, "Chiave servizio mancante");
  const current = (await query("SELECT * FROM services_catalog WHERE key = $1", [cleanKey])).rows[0];
  if (!current) throw httpError(404, "Servizio non trovato");
  const result = await query(
    `UPDATE services_catalog
     SET label = $1, description = $2, active = $3
     WHERE key = $4 RETURNING *`,
    [
      label === undefined ? current.label : String(label).trim().slice(0, 100),
      description === undefined ? current.description : String(description).slice(0, 2000),
      active === undefined ? current.active : !!active,
      cleanKey,
    ]
  );
  return result.rows[0];
}

export async function deleteService(key) {
  const cleanKey = normalizeServiceKey(key);
  if (!cleanKey) throw httpError(400, "Chiave servizio mancante");
  const result = await query("DELETE FROM services_catalog WHERE key = $1 RETURNING id", [cleanKey]);
  if (!result.rows[0]) throw httpError(404, "Servizio non trovato");
  return { deleted: true, key: cleanKey };
}

// ── Clienti ───────────────────────────────────────────────────────────────

// Marca (o smarca) un contatto come cliente. Il contatto deve appartenere
// al sito (check site_id nella WHERE). client_status valido:
// 'inactive' | 'active' | 'suspended'.
export async function markClient(siteId, contactId, { is_client, client_status } = {}) {
  const cid = parseInt(contactId, 10);
  if (!Number.isInteger(cid) || cid < 1) throw httpError(400, "Contatto non valido");
  const current = (await query(
    "SELECT id, is_client, client_status FROM contacts WHERE id = $1 AND site_id = $2",
    [cid, siteId]
  )).rows[0];
  if (!current) throw httpError(404, "Contatto non trovato");

  const wantsClient = is_client === undefined ? current.is_client : !!is_client;
  let status = current.client_status;
  if (client_status !== undefined) {
    const s = String(client_status).trim().toLowerCase();
    if (!CLIENT_STATUSES.has(s)) throw httpError(400, `Stato cliente non valido: ${s}`);
    status = s;
  }
  // Se si smarca il cliente, lo stato torna 'inactive'.
  if (!wantsClient) status = "inactive";

  const result = await query(
    "UPDATE contacts SET is_client = $1, client_status = $2, updated_at = NOW() WHERE id = $3 AND site_id = $4 RETURNING id, email, is_client, client_status",
    [wantsClient, status, cid, siteId]
  );
  return result.rows[0];
}

// Lista clienti del sito. status opzionale filtra ('active', 'suspended', ...).
// Ogni riga include i servizi attivi (array di key) e il totale servizi.
export async function listClients(siteId, { status } = {}) {
  const params = [siteId];
  let where = "c.is_client = true AND c.site_id = $1";
  if (status) {
    params.push(String(status));
    where += ` AND c.client_status = $${params.length}`;
  }
  const result = await query(
    `SELECT c.id, c.email, c.is_client, c.client_status, c.created_at, c.updated_at,
            COALESCE(ARRAY_AGG(DISTINCT sc.key) FILTER (WHERE cs.active AND sc.active), '{}') AS active_services
     FROM contacts c
     LEFT JOIN client_services cs ON cs.contact_id = c.id
     LEFT JOIN services_catalog sc ON sc.id = cs.service_id
     WHERE ${where}
     GROUP BY c.id
     ORDER BY c.email`,
    params
  );
  return result.rows;
}

export async function getClient(siteId, contactId) {
  const cid = parseInt(contactId, 10);
  if (!Number.isInteger(cid) || cid < 1) return null;
  const result = await query(
    `SELECT c.id, c.email, c.is_client, c.client_status, c.created_at, c.updated_at,
            COALESCE(ARRAY_AGG(DISTINCT sc.key) FILTER (WHERE cs.active AND sc.active), '{}') AS active_services
     FROM contacts c
     LEFT JOIN client_services cs ON cs.contact_id = c.id
     LEFT JOIN services_catalog sc ON sc.id = cs.service_id
     WHERE c.id = $1 AND c.site_id = $2
     GROUP BY c.id`,
    [cid, siteId]
  );
  return result.rows[0] || null;
}

// ── Servizi del cliente ───────────────────────────────────────────────────

export async function listClientServices(siteId, contactId) {
  const cid = parseInt(contactId, 10);
  if (!Number.isInteger(cid) || cid < 1) throw httpError(400, "Contatto non valido");
  const contact = (await query("SELECT id FROM contacts WHERE id = $1 AND site_id = $2", [cid, siteId])).rows[0];
  if (!contact) throw httpError(404, "Contatto non trovato");
  const result = await query(
    `SELECT sc.key, sc.label, sc.description AS service_description, sc.active AS service_active,
            cs.active, cs.activated_at, cs.deactivated_at, cs.config
     FROM services_catalog sc
     LEFT JOIN client_services cs ON cs.service_id = sc.id AND cs.contact_id = $1
     WHERE sc.active = true
     ORDER BY sc.key`,
    [cid]
  );
  return result.rows;
}

// Attiva/disattiva un servizio per un cliente (upsert).
export async function setClientService(siteId, contactId, serviceKey, active, config = null) {
  const cid = parseInt(contactId, 10);
  if (!Number.isInteger(cid) || cid < 1) throw httpError(400, "Contatto non valido");
  const cleanKey = normalizeServiceKey(serviceKey);
  if (!cleanKey) throw httpError(400, "Chiave servizio mancante");
  const contact = (await query("SELECT id FROM contacts WHERE id = $1 AND site_id = $2", [cid, siteId])).rows[0];
  if (!contact) throw httpError(404, "Contatto non trovato");
  const service = (await query("SELECT id FROM services_catalog WHERE key = $1", [cleanKey])).rows[0];
  if (!service) throw httpError(404, "Servizio non trovato");

  const isActive = !!active;
  const result = await query(
    `INSERT INTO client_services (contact_id, service_id, active, activated_at, deactivated_at, config)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contact_id, service_id)
     DO UPDATE SET active = $3,
                   activated_at = CASE WHEN $3 THEN NOW() ELSE client_services.activated_at END,
                   deactivated_at = CASE WHEN $3 THEN NULL ELSE NOW() END,
                   config = $6
     RETURNING *`,
    [
      cid,
      service.id,
      isActive,
      new Date(),
      isActive ? null : new Date(),
      config && typeof config === "object" ? JSON.stringify(config) : null,
    ]
  );
  return result.rows[0];
}

// ── Verifica accesso (usata dal servizio esterno) ─────────────────────────
//
// Regola: has_access = true SOLO se
//   1. il contatto esiste, è marcato cliente (is_client) e ha status 'active'
//   2. il servizio esiste nel catalogo ed è attivo (catalogo.active)
//   3. esiste una riga client_services attiva per (contatto, servizio)
// Qualunque condizione mancante → has_access: false (deny by default).
export async function checkClientAccess(siteId, contactId, serviceKey) {
  const cid = parseInt(contactId, 10);
  const cleanKey = normalizeServiceKey(serviceKey);
  if (!Number.isInteger(cid) || cid < 1 || !cleanKey) {
    return { has_access: false, reason: "parametri non validi" };
  }
  const result = await query(
    `SELECT c.is_client, c.client_status, sc.key AS service_key, sc.active AS service_active, cs.active AS granted
     FROM contacts c
     JOIN services_catalog sc ON sc.key = $3
     LEFT JOIN client_services cs ON cs.contact_id = c.id AND cs.service_id = sc.id
     WHERE c.id = $1 AND c.site_id = $2`,
    [cid, siteId, cleanKey]
  );
  const row = result.rows[0];
  if (!row) return { has_access: false, reason: "contatto o servizio non trovato" };
  if (!row.is_client) return { has_access: false, reason: "contatto non cliente" };
  if (row.client_status !== "active") return { has_access: false, reason: `cliente ${row.client_status}` };
  if (!row.service_active) return { has_access: false, reason: "servizio disattivato nel catalogo" };
  if (!row.granted) return { has_access: false, reason: "servizio non assegnato" };
  return { has_access: true, reason: "ok", service: cleanKey, client_status: row.client_status };
}

// Variante per email: comoda per il servizio esterno che conosce l'email
// del cliente (es. login su area clienti) e non l'id del contatto.
export async function checkClientAccessByEmail(siteId, email, serviceKey) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail) return { has_access: false, reason: "email mancante" };
  const contact = (await query(
    "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = $2",
    [siteId, cleanEmail]
  )).rows[0];
  if (!contact) return { has_access: false, reason: "contatto non trovato" };
  return checkClientAccess(siteId, contact.id, serviceKey);
}

export { logger };
