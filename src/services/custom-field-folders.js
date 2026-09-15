import { query } from "../db.js";
import { getExternalId } from "./external-ids.js";

// Servizio custom field folder per-tenant. Un folder ha nome univoco per sito.

export async function listFolders(siteId, { limit = 20, startAfterId = null } = {}) {
  let query_str = "SELECT * FROM custom_field_folders WHERE site_id = $1 ORDER BY id ASC";
  const params = [siteId];

  if (startAfterId) {
    const offsetRow = (await query(
      "SELECT id FROM custom_field_folders WHERE external_id = $1",
      [startAfterId]
    )).rows[0];
    if (offsetRow) {
      query_str += ` AND id > $${params.length + 1}`;
      params.push(offsetRow.id);
    }
  }

  query_str += ` LIMIT $${params.length + 1}`;
  params.push(limit + 1);

  const rows = (await query(query_str, params)).rows;
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  const countRow = (await query(
    `SELECT COUNT(*) as count FROM custom_field_folders WHERE site_id = $1`,
    [siteId]
  )).rows[0];
  const total = parseInt(countRow.count, 10);

  const nextStartAfterId = hasMore
    ? await getExternalId("custom_field_folders", pageRows[pageRows.length - 1].id)
    : null;

  return { rows: pageRows, total, nextStartAfterId };
}

export async function getFolder(siteId, id) {
  const row = (await query(
    `SELECT * FROM custom_field_folders WHERE id = $1 AND site_id = $2`,
    [id, siteId]
  )).rows[0];
  return row || null;
}

export async function getFolderByExternalId(siteId, externalId) {
  const row = (await query(
    `SELECT * FROM custom_field_folders WHERE external_id = $1 AND site_id = $2`,
    [externalId, siteId]
  )).rows[0];
  return row || null;
}

export async function createFolder(siteId, data) {
  const { name } = data;
  if (!name) return null;

  try {
    const row = (await query(
      `INSERT INTO custom_field_folders (site_id, name) VALUES ($1, $2) RETURNING *`,
      [siteId, name]
    )).rows[0];
    return row;
  } catch (err) {
    if (err.code === "23505") {
      const e = new Error("Cartella già esistente");
      e.status = 409;
      e.code = 409;
      throw e;
    }
    throw err;
  }
}

export async function deleteFolder(siteId, id) {
  const result = await query(
    `DELETE FROM custom_field_folders WHERE id = $1 AND site_id = $2`,
    [id, siteId]
  );
  return result.rowCount > 0;
}
