import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Custom field values per-tenant (ONDA 1).
//
// I valori custom field di un contatto/opportunità vivono in
// `contact_custom_values` come `{ field_key: value }` (JSONB), validati
// contro la definizione del custom field (tabella `custom_fields`, stesso
// object_key). I field_key non definiti per quel tenant/object vengono
// ignorati (con warn), così definizioni cancellate non rompono i payload.
//
// Per il profilo del contatto (name/firstName/lastName/phone/companyName/
// website) si usa lo stesso storage con field_key canonici e
// object_key='contact': un unico punto per custom di profilo e custom
// definiti dall'utente.
// ─────────────────────────────────────────────────────────────────────────

export async function getCustomValues(siteId, contactId, objectKey = "contact") {
  const id = parseInt(contactId, 10);
  if (!id) return {};
  const row = (await query(
    "SELECT values FROM contact_custom_values WHERE site_id = $1 AND contact_id = $2 AND object_key = $3",
    [siteId, id, objectKey]
  )).rows[0];
  if (!row) return {};
  return typeof row.values === "string" ? JSON.parse(row.values) : (row.values || {});
}

// Valori custom DEFINITI per il tenant su questo object_key (per validare).
async function definedKeys(siteId, objectKey) {
  const rows = (await query(
    "SELECT field_key FROM custom_fields WHERE site_id = $1 AND object_key = $2 AND active = true",
    [siteId, objectKey]
  )).rows;
  return new Set(rows.map((r) => r.field_key));
}

function sanitizeJson(v) {
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

// Chiavi riservate del PROFILO contatto (sistemiche, non custom field): vivono
// negli stessi custom values con object_key='contact'. Non richiedono una
// definizione in `custom_fields` (sono il profilo standard del contatto).
const PROFILE_KEYS = new Set(["name", "firstName", "lastName", "phone", "companyName", "website"]);

// Salva (sostituisce) i custom values. `values` = { field_key: value }. Le
// chiavi non definite per il tenant/object (e non riservate di profilo)
// vengono scartate (warn).
export async function setCustomValues(siteId, contactId, objectKey = "contact", values = {}) {
  const id = parseInt(contactId, 10);
  if (!id) return {};
  const allowed = await definedKeys(siteId, objectKey);
  const clean = {};
  for (const [k, v] of Object.entries(values || {})) {
    const reserved = objectKey === "contact" && PROFILE_KEYS.has(k);
    if (!reserved && !allowed.has(k)) { logger.warn(`custom-values: field_key '${k}' non definito per ${objectKey} (site=${siteId}) — ignorato`); continue; }
    clean[k] = v;
  }
  await query(
    `INSERT INTO contact_custom_values (site_id, contact_id, object_key, values)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, contact_id, object_key)
     DO UPDATE SET values = EXCLUDED.values, updated_at = NOW()`,
    [siteId, id, objectKey, JSON.stringify(clean)]
  );
  return clean;
}

// Unisce (merge) i custom values con quelli esistenti.
export async function mergeCustomValues(siteId, contactId, objectKey = "contact", values = {}) {
  const current = await getCustomValues(siteId, contactId, objectKey);
  return setCustomValues(siteId, contactId, objectKey, { ...current, ...values });
}

export async function clearCustomValues(siteId, contactId) {
  const id = parseInt(contactId, 10);
  if (!id) return;
  await query(
    "DELETE FROM contact_custom_values WHERE site_id = $1 AND contact_id = $2",
    [siteId, id]
  );
}
