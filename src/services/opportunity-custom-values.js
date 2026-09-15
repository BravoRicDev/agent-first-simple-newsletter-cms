import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// RIFINITURA v1 — Valori custom field delle OPPORTUNITÀ (object_key='opportunity').
//
// Identico pattern di `custom-values.js` (contatti), ma su una tabella
// dedicata `opportunity_custom_values`. Non può usare `contact_custom_values`
// perché quell'FK è su contacts(id). I valori vivono in `values` come
// `{ field_key: value }` (JSONB), validati contro la definizione in
// `custom_fields` (object_key='opportunity', field_key stabile). I field_key
// non definiti per il tenant vengono ignorati (con warn), così definizioni
// cancellate non rompono i payload.
// ─────────────────────────────────────────────────────────────────────────

const OBJECT_KEY = "opportunity";

export async function getOpportunityCustomValues(siteId, opportunityId) {
  const id = parseInt(opportunityId, 10);
  if (!id) return {};
  const row = (await query(
    "SELECT values FROM opportunity_custom_values WHERE site_id = $1 AND opportunity_id = $2",
    [siteId, id]
  )).rows[0];
  if (!row) return {};
  return typeof row.values === "string" ? JSON.parse(row.values) : (row.values || {});
}

// Valori custom DEFINITI per il tenant su questo object_key (per validare).
async function definedKeys(siteId) {
  const rows = (await query(
    "SELECT field_key FROM custom_fields WHERE site_id = $1 AND object_key = 'opportunity' AND active = true",
    [siteId]
  )).rows;
  return new Set(rows.map((r) => r.field_key));
}

// Salva (sostituisce) i custom values. `values` = { field_key: value }.
// Le chiavi non definite per il tenant vengono scartate (warn).
export async function setOpportunityCustomValues(siteId, opportunityId, values = {}) {
  const id = parseInt(opportunityId, 10);
  if (!id) return {};
  const allowed = await definedKeys(siteId);
  const clean = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!allowed.has(k)) { logger.warn(`custom-values(opportunity): field_key '${k}' non definito (site=${siteId}) — ignorato`); continue; }
    clean[k] = v;
  }
  await query(
    `INSERT INTO opportunity_custom_values (site_id, opportunity_id, values)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, opportunity_id)
     DO UPDATE SET values = EXCLUDED.values, updated_at = NOW()`,
    [siteId, id, JSON.stringify(clean)]
  );
  return clean;
}

// Unisce (merge) i custom values con quelli esistenti.
export async function mergeOpportunityCustomValues(siteId, opportunityId, values = {}) {
  const current = await getOpportunityCustomValues(siteId, opportunityId);
  return setOpportunityCustomValues(siteId, opportunityId, { ...current, ...values });
}

export async function clearOpportunityCustomValues(siteId, opportunityId) {
  const id = parseInt(opportunityId, 10);
  if (!id) return;
  await query(
    "DELETE FROM opportunity_custom_values WHERE site_id = $1 AND opportunity_id = $2",
    [siteId, id]
  );
}
