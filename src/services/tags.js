import { query } from "../db.js";
import { getExternalId } from "./external-ids.js";

// Servizio tag per-tenant. Un tag ha nome univoco per sito.

export async function listTags(siteId, { limit = 20, startAfterId = null } = {}) {
  let query_str = "SELECT * FROM tags WHERE site_id = $1 ORDER BY id ASC";
  const params = [siteId];

  if (startAfterId) {
    const offsetRow = (await query(
      "SELECT id FROM tags WHERE external_id = $1",
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
    `SELECT COUNT(*) as count FROM tags WHERE site_id = $1`,
    [siteId]
  )).rows[0];
  const total = parseInt(countRow.count, 10);

  const nextStartAfterId = hasMore
    ? await getExternalId("tags", pageRows[pageRows.length - 1].id)
    : null;

  return { rows: pageRows, total, nextStartAfterId };
}

export async function getTag(siteId, id) {
  const row = (await query(
    `SELECT * FROM tags WHERE id = $1 AND site_id = $2`,
    [id, siteId]
  )).rows[0];
  return row || null;
}

export async function getTagByExternalId(siteId, externalId) {
  const row = (await query(
    `SELECT * FROM tags WHERE external_id = $1 AND site_id = $2`,
    [externalId, siteId]
  )).rows[0];
  return row || null;
}

export async function createTag(siteId, data) {
  const { name, color = null } = data;
  if (!name) return null;

  try {
    const row = (await query(
      `INSERT INTO tags (site_id, name, color) VALUES ($1, $2, $3) RETURNING *`,
      [siteId, name, color]
    )).rows[0];
    return row;
  } catch (err) {
    if (err.code === "23505") {
      const e = new Error("Tag già esistente");
      e.status = 409;
      e.code = 409;
      throw e;
    }
    throw err;
  }
}

export async function updateTag(siteId, id, data) {
  const current = await getTag(siteId, id);
  if (!current) return null;

  const { name = current.name, color = current.color } = data;

  try {
    await query(
      `UPDATE tags SET name = $1, color = $2, updated_at = NOW() WHERE id = $3 AND site_id = $4`,
      [name, color, id, siteId]
    );
  } catch (err) {
    if (err.code === "23505") {
      const e = new Error("Tag già esistente");
      e.status = 409;
      e.code = 409;
      throw e;
    }
    throw err;
  }

  return getTag(siteId, id);
}

export async function deleteTag(siteId, id) {
  const result = await query(
    `DELETE FROM tags WHERE id = $1 AND site_id = $2`,
    [id, siteId]
  );
  return result.rowCount > 0;
}
