import { query } from "../db.js";
import { ensureExternalId, findByExternalId } from "./external-ids.js";

export async function listMediaFiles(siteId, { limit = 20, startAfterId = null } = {}) {
  // Paginazione cursor-based: se startAfterId è fornito, trova quel record
  // e poi seleziona i successivi.
  let params = [siteId];
  let where = "site_id = $1";
  let orderBy = "id ASC";

  if (startAfterId) {
    const afterRecord = await findByExternalId("media_files", startAfterId);
    if (!afterRecord) {
      return { files: [], total: 0, nextStartAfterId: null };
    }
    params.push(afterRecord.id);
    where += ` AND id > $${params.length}`;
  }

  const countResult = await query(
    `SELECT COUNT(*) as total FROM media_files WHERE site_id = $1`,
    [siteId]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const rows = (await query(
    `SELECT * FROM media_files WHERE ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1}`,
    [...params, limit + 1]
  )).rows;

  const hasMore = rows.length > limit;
  const files = rows.slice(0, limit);

  let nextStartAfterId = null;
  if (hasMore && files.length > 0) {
    nextStartAfterId = files[files.length - 1].external_id;
  }

  return { files, total, nextStartAfterId };
}

export async function getMediaFile(siteId, externalId) {
  const row = await findByExternalId("media_files", externalId);
  if (!row || row.site_id !== siteId) {
    return null;
  }
  return row;
}

export async function registerMediaFile(siteId, { url, filename, mimeType = null, sizeBytes = 0, alt = "" }) {
  // Registra un file GIÀ esistente nel filesystem (upload avviene altrove).
  // ON CONFLICT perché potrebbe esistere già (doppio register).
  const row = (await query(
    `INSERT INTO media_files (site_id, url, filename, mime_type, size_bytes, alt)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id, filename, url) DO UPDATE SET
       mime_type = EXCLUDED.mime_type,
       size_bytes = EXCLUDED.size_bytes,
       alt = EXCLUDED.alt
     RETURNING *`,
    [siteId, url, filename, mimeType, sizeBytes, alt]
  )).rows[0];
  return row;
}

export async function updateMediaFile(siteId, externalId, { alt = null } = {}) {
  const file = await getMediaFile(siteId, externalId);
  if (!file) return null;

  let updates = [];
  let params = [];
  let paramCount = 1;

  if (alt !== null) {
    updates.push(`alt = $${paramCount++}`);
    params.push(alt);
  }

  if (updates.length === 0) return file;

  params.push(file.id, siteId);
  const row = (await query(
    `UPDATE media_files SET ${updates.join(", ")}, created_at = created_at
     WHERE id = $${paramCount} AND site_id = $${paramCount + 1}
     RETURNING *`,
    params
  )).rows[0];
  return row || null;
}

export async function deleteMediaFile(siteId, externalId) {
  const file = await getMediaFile(siteId, externalId);
  if (!file) return false;

  await query(
    "DELETE FROM media_files WHERE id = $1 AND site_id = $2",
    [file.id, siteId]
  );
  return true;
}

export function serializeMediaFile(row, locationId) {
  if (!row) return null;
  return {
    id: row.external_id,
    locationId,
    filename: row.filename,
    url: row.url,
    mimeType: row.mime_type,
    // BIGINT arriva come stringa da pg: normalizza a number
    sizeBytes: Number(row.size_bytes || 0),
    alt: row.alt || "",
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
  };
}
