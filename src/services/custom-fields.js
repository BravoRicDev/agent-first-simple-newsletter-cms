import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Custom fields per-tenant (id stabili / chiave stabile).
//
// Un custom field ha una `field_key` stabile (slug) univoca per (site_id,
// object_key): è la chiave che resta stabile tra rappresentazioni JSON per
// l'integrazione. L'`id` numerico è stabile per il tenant.
//
// Emette evento `custom_field_updated` (fire-and-forget) su create/update/
// delete, per alimentare webhook OUT / workflow.
// ─────────────────────────────────────────────────────────────────────────

const ALLOWED_TYPES = new Set(["text", "number", "date", "checkbox", "select", "textarea"]);
const ALLOWED_OBJECTS = new Set(["contact", "opportunity"]);

function emitCustomFieldEvent(siteId, eventType, payload) {
  import("./events.js").then(({ emitContactEvent }) => {
    // Gli eventi contact-event richiedono un'email; per un custom field
    // non c'è un contatto, quindi usiamo un segnaposto email sentinella
    // coerente con il sito. In alternativa si potrebbe estendere il sistema
    // eventi, ma per ora resta fire-and-forget e best-effort.
    emitContactEvent(siteId, `custom-field@${siteId}.local`, eventType, payload);
  }).catch((err) => logger.error(`custom field event emit fallito (${eventType}): ${err.message}`));
}

function slugify(value) {
  // Chiave stabile: lowercase, alfanumerico + trattino basso/singolo.
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

function normalizeData(data = {}) {
  const type = String(data.type || "text");
  const objectKey = String(data.object_key || "contact");
  const out = {
    object_key: ALLOWED_OBJECTS.has(objectKey) ? objectKey : null,
    field_key: slugify(data.field_key),
    name: String(data.name || "").slice(0, 255),
    type: ALLOWED_TYPES.has(type) ? type : null,
    options: Array.isArray(data.options) ? data.options : [],
    is_public: data.is_public === true || data.is_public === "true",
    active: data.active === undefined ? true : (data.active === true || data.active === "true"),
    position: Number.isFinite(Number(data.position)) ? Math.max(0, Number(data.position)) : 0,
  };
  return out;
}

function mapRow(row) {
  if (!row) return row;
  return {
    ...row,
    options: typeof row.options === "string" ? JSON.parse(row.options) : row.options,
  };
}

export async function listCustomFields(siteId, { objectKey = null } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (objectKey) {
    params.push(slugify(objectKey));
    where += " AND object_key = $2";
  }
  const rows = (await query(
    `SELECT * FROM custom_fields WHERE ${where} ORDER BY position, id`,
    params
  )).rows;
  return rows.map(mapRow);
}

export async function listByObjectKey(siteId, objectKey) {
  return listCustomFields(siteId, { objectKey });
}

export async function getCustomField(siteId, id) {
  const row = (await query(
    "SELECT * FROM custom_fields WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  return mapRow(row || null);
}

export async function createCustomField(siteId, data) {
  const d = normalizeData(data);
  if (!d.object_key || !d.field_key || !d.type) return null;

  const row = (await query(
    `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, options, is_public, active, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (site_id, object_key, field_key) DO UPDATE SET
       name = EXCLUDED.name, type = EXCLUDED.type, options = EXCLUDED.options,
       is_public = EXCLUDED.is_public, active = EXCLUDED.active,
       position = EXCLUDED.position, updated_at = NOW()
     RETURNING *`,
    [siteId, d.object_key, d.field_key, d.name, d.type,
     JSON.stringify(d.options), d.is_public, d.active, d.position]
  )).rows[0];

  emitCustomFieldEvent(siteId, "custom_field_updated", {
    action: "create", custom_field: { id: row.id, object_key: row.object_key, field_key: row.field_key },
  });
  return mapRow(row);
}

export async function updateCustomField(siteId, id, data) {
  const current = await getCustomField(siteId, id);
  if (!current) return null;

  const d = normalizeData({ ...current, ...data });
  if (!d.object_key || !d.field_key || !d.type) return null;

  await query(
    `UPDATE custom_fields SET name = $1, type = $2, options = $3, is_public = $4,
       active = $5, position = $6, updated_at = NOW()
     WHERE id = $7 AND site_id = $8`,
    [d.name, d.type, JSON.stringify(d.options), d.is_public, d.active, d.position,
     parseInt(id, 10), siteId]
  );

  emitCustomFieldEvent(siteId, "custom_field_updated", {
    action: "update", custom_field_id: current.id, object_key: current.object_key, field_key: current.field_key,
  });
  return getCustomField(siteId, id);
}

export async function deleteCustomField(siteId, id) {
  const row = (await query(
    "DELETE FROM custom_fields WHERE id = $1 AND site_id = $2 RETURNING *",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (row) {
    emitCustomFieldEvent(siteId, "custom_field_updated", {
      action: "delete", custom_field_id: row.id, object_key: row.object_key, field_key: row.field_key,
    });
  }
  return row ? row.id : null;
}
