import { query } from "../db.js";
import { ensureExternalId, findByExternalId } from "./external-ids.js";

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

// ─────────────────────────────────────────────────────────────────────────
// Object Definitions: schema di oggetti custom
// ─────────────────────────────────────────────────────────────────────────

export async function listObjectDefinitions(siteId, { limit = 20, startAfterId = null } = {}) {
  let params = [siteId];
  let where = "site_id = $1";

  if (startAfterId) {
    const afterRecord = await findByExternalId("object_definitions", startAfterId);
    if (!afterRecord) {
      return { objectDefinitions: [], total: 0, nextStartAfterId: null };
    }
    params.push(afterRecord.id);
    where += ` AND id > $${params.length}`;
  }

  const countResult = await query(
    "SELECT COUNT(*) as total FROM object_definitions WHERE site_id = $1",
    [siteId]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const rows = (await query(
    `SELECT * FROM object_definitions WHERE ${where} ORDER BY id ASC LIMIT $${params.length + 1}`,
    [...params, limit + 1]
  )).rows;

  const hasMore = rows.length > limit;
  const definitions = rows.slice(0, limit);

  let nextStartAfterId = null;
  if (hasMore && definitions.length > 0) {
    nextStartAfterId = definitions[definitions.length - 1].external_id;
  }

  return { objectDefinitions: definitions, total, nextStartAfterId };
}

export async function getObjectDefinition(siteId, externalId) {
  const row = await findByExternalId("object_definitions", externalId);
  if (!row || row.site_id !== siteId) {
    return null;
  }
  return row;
}

export async function getObjectDefinitionByKey(siteId, objectKey) {
  const key = slugify(objectKey);
  const row = (await query(
    "SELECT * FROM object_definitions WHERE site_id = $1 AND object_key = $2",
    [siteId, key]
  )).rows[0];
  return row || null;
}

export async function createObjectDefinition(
  siteId,
  { objectKey, pluralLabel = null, primaryField = "name" } = {}
) {
  const key = slugify(objectKey);
  if (!key) return null;

  const row = (await query(
    `INSERT INTO object_definitions (site_id, object_key, plural_label, primary_field)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, object_key) DO UPDATE SET
       plural_label = EXCLUDED.plural_label,
       primary_field = EXCLUDED.primary_field,
       updated_at = NOW()
     RETURNING *`,
    [siteId, key, pluralLabel || null, primaryField]
  )).rows[0];
  return row;
}

export async function updateObjectDefinition(siteId, externalId, updates = {}) {
  const def = await getObjectDefinition(siteId, externalId);
  if (!def) return null;

  let setClauses = ["updated_at = NOW()"];
  let params = [];
  let paramCount = 1;

  if (updates.pluralLabel !== undefined) {
    setClauses.push(`plural_label = $${paramCount++}`);
    params.push(updates.pluralLabel || null);
  }
  if (updates.primaryField !== undefined) {
    setClauses.push(`primary_field = $${paramCount++}`);
    params.push(updates.primaryField);
  }

  if (setClauses.length === 1) return def; // Solo updated_at

  params.push(def.id, siteId);
  const row = (await query(
    `UPDATE object_definitions SET ${setClauses.join(", ")}
     WHERE id = $${paramCount} AND site_id = $${paramCount + 1}
     RETURNING *`,
    params
  )).rows[0];
  return row || null;
}

export async function deleteObjectDefinition(siteId, externalId) {
  const def = await getObjectDefinition(siteId, externalId);
  if (!def) return false;

  await query(
    "DELETE FROM object_definitions WHERE id = $1 AND site_id = $2",
    [def.id, siteId]
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Object Records: istanze di oggetti custom
// ─────────────────────────────────────────────────────────────────────────

export async function listObjectRecords(siteId, definitionId, { limit = 20, startAfterId = null } = {}) {
  // Assicura che definitionId è valido per il siteId
  const def = await query(
    "SELECT id FROM object_definitions WHERE id = $1 AND site_id = $2",
    [definitionId, siteId]
  );
  if (!def.rows.length) return null;

  let params = [definitionId];
  let where = "definition_id = $1";

  if (startAfterId) {
    const afterRecord = await findByExternalId("object_records", startAfterId);
    if (!afterRecord) {
      return { records: [], total: 0, nextStartAfterId: null };
    }
    params.push(afterRecord.id);
    where += ` AND id > $${params.length}`;
  }

  const countResult = await query(
    "SELECT COUNT(*) as total FROM object_records WHERE definition_id = $1",
    [definitionId]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const rows = (await query(
    `SELECT * FROM object_records WHERE ${where} ORDER BY id ASC LIMIT $${params.length + 1}`,
    [...params, limit + 1]
  )).rows;

  const hasMore = rows.length > limit;
  const records = rows.slice(0, limit);

  let nextStartAfterId = null;
  if (hasMore && records.length > 0) {
    nextStartAfterId = records[records.length - 1].external_id;
  }

  return { records, total, nextStartAfterId };
}

export async function getObjectRecord(siteId, recordExternalId) {
  const row = await findByExternalId("object_records", recordExternalId);
  if (!row || row.site_id !== siteId) {
    return null;
  }
  return row;
}

export async function createObjectRecord(siteId, definitionId, data = {}) {
  // Valida che definitionId esista per il siteId
  const def = await query(
    "SELECT * FROM object_definitions WHERE id = $1 AND site_id = $2",
    [definitionId, siteId]
  );
  if (!def.rows.length) return null;

  const row = (await query(
    `INSERT INTO object_records (site_id, definition_id, data)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [siteId, definitionId, JSON.stringify(data)]
  )).rows[0];
  return row;
}

export async function updateObjectRecord(siteId, recordExternalId, data = {}) {
  const record = await getObjectRecord(siteId, recordExternalId);
  if (!record) return null;

  // Merge: aggiorna i campi forniti, mantiene il resto
  const merged = { ...record.data, ...data };

  const row = (await query(
    `UPDATE object_records SET data = $1, updated_at = NOW()
     WHERE id = $2 AND site_id = $3
     RETURNING *`,
    [JSON.stringify(merged), record.id, siteId]
  )).rows[0];
  return row || null;
}

export async function deleteObjectRecord(siteId, recordExternalId) {
  const record = await getObjectRecord(siteId, recordExternalId);
  if (!record) return false;

  await query(
    "DELETE FROM object_records WHERE id = $1 AND site_id = $2",
    [record.id, siteId]
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Object Associations: relazioni tra record
// ─────────────────────────────────────────────────────────────────────────

export async function listAssociations(siteId, recordExternalId, { relation = null } = {}) {
  const record = await getObjectRecord(siteId, recordExternalId);
  if (!record) return null;

  let params = [record.id];
  let where = "oa.from_record_id = $1";

  if (relation) {
    params.push(relation);
    where += ` AND oa.relation = $${params.length}`;
  }

  const rows = (await query(
    `SELECT oa.id, oa.from_record_id, oa.to_record_id, oa.relation,
            fr.external_id as from_external_id, tr.external_id as to_external_id
     FROM object_associations oa
     JOIN object_records fr ON oa.from_record_id = fr.id
     JOIN object_records tr ON oa.to_record_id = tr.id
     WHERE ${where}
     ORDER BY oa.id ASC`,
    params
  )).rows;

  return rows;
}

export async function createAssociation(siteId, recordExternalId, { toRecordId, relation = "related" }) {
  const fromRecord = await getObjectRecord(siteId, recordExternalId);
  if (!fromRecord) return null;

  const toRecord = await getObjectRecord(siteId, toRecordId);
  if (!toRecord) return null;

  const row = (await query(
    `INSERT INTO object_associations (from_record_id, to_record_id, relation)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_record_id, to_record_id, relation) DO NOTHING
     RETURNING *`,
    [fromRecord.id, toRecord.id, relation]
  )).rows[0];
  return row || null;
}

export async function deleteAssociation(siteId, recordExternalId, toRecordExternalId, relation = null) {
  const fromRecord = await getObjectRecord(siteId, recordExternalId);
  if (!fromRecord) return false;

  const toRecord = await getObjectRecord(siteId, toRecordExternalId);
  if (!toRecord) return false;

  let params = [fromRecord.id, toRecord.id];
  let where = "from_record_id = $1 AND to_record_id = $2";

  if (relation) {
    params.push(relation);
    where += ` AND relation = $${params.length}`;
  }

  await query(`DELETE FROM object_associations WHERE ${where}`, params);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Serializers
// ─────────────────────────────────────────────────────────────────────────

export function serializeObjectDefinition(row, locationId) {
  if (!row) return null;
  return {
    id: row.external_id,
    locationId,
    objectKey: row.object_key,
    pluralLabel: row.plural_label,
    primaryField: row.primary_field,
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

export function serializeObjectRecord(row, locationId, objectKey) {
  if (!row) return null;
  return {
    id: row.external_id,
    locationId,
    objectKey,
    data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

export function serializeAssociation(row) {
  if (!row) return null;
  return {
    fromRecordId: row.from_external_id,
    toRecordId: row.to_external_id,
    relation: row.relation,
  };
}
