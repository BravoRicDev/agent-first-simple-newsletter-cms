import { query } from "../db.js";
import { getExternalId } from "./external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda C: Servizio forms per clone API.
// Trasformazioni: camelCase (locationId, dateAdded, dateUpdated),
// id esterno (uuid), slug autogenerato da name.
// ─────────────────────────────────────────────────────────────────────────

export function serializeForm(row, locationId = null) {
  if (!row) return null;
  return {
    id: row.external_id,
    locationId,
    name: row.name || "",
    dateAdded: row.created_at?.toISOString() || null,
    dateUpdated: row.updated_at?.toISOString() || null,
  };
}

export function serializeSubmission(row, locationId = null) {
  if (!row) return null;
  const data = row.data || {};
  const firstName = data.firstName || data.first_name || "";
  const lastName = data.lastName || data.last_name || "";
  const name = (firstName && lastName) ? `${firstName} ${lastName}` : null;
  return {
    id: row.external_id,
    formId: row.form_id_ext || null,
    contactId: row.contact_id_ext || null,
    submittedAt: row.created_at?.toISOString() || null,
    name,
    submission: data,
  };
}

// Genera slug univoco da name: lowercase, replace spazi/caratteri speciali
function slugify(name) {
  return (name || "form")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Risolvi formId uuid → form id interno.
async function resolveFormInternalId(siteId, formIdUuid) {
  if (!formIdUuid) return null;
  const row = (await query(
    `SELECT id FROM forms WHERE site_id = $1 AND external_id = $2`,
    [siteId, formIdUuid]
  )).rows[0];
  return row?.id || null;
}

export async function listForms(siteId, filters = {}, locationId = null) {
  const params = [siteId];
  let where = "f.site_id = $1";

  if (filters.q) {
    params.push(`%${filters.q}%`);
    where += ` AND f.name ILIKE $${params.length}`;
  }

  // Count totale
  const countRow = (await query(
    `SELECT COUNT(*)::int AS cnt FROM forms f WHERE ${where}`,
    params
  )).rows[0];
  const total = countRow?.cnt || 0;

  // Lista con paginazione cursore
  let limit = filters.limit || 20;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  let orderClause = "ORDER BY f.id DESC";
  if (filters.startAfterId) {
    const afterRow = (await query(
      `SELECT id FROM forms WHERE external_id = $1 AND site_id = $2`,
      [filters.startAfterId, siteId]
    )).rows[0];
    if (afterRow) {
      params.push(afterRow.id);
      where += ` AND f.id < $${params.length}`;
    }
  }

  params.push(limit + 1);
  const limitParam = params.length;
  const rows = (await query(
    `SELECT * FROM forms f WHERE ${where} ${orderClause} LIMIT $${limitParam}`,
    params
  )).rows;

  let nextStartAfterId = null;
  let items = rows.slice(0, limit);
  if (rows.length > limit) {
    nextStartAfterId = rows[limit].external_id;
  }

  const forms = items.map(row => serializeForm(row, locationId));
  return { forms, total, nextStartAfterId };
}

export async function getForm(siteId, externalId, locationId = null) {
  const row = (await query(
    `SELECT * FROM forms WHERE site_id = $1 AND external_id = $2`,
    [siteId, externalId]
  )).rows[0];
  return row ? serializeForm(row, locationId) : null;
}

export async function createForm(siteId, name, locationId = null) {
  if (!name || !name.trim()) return null;

  const trimmedName = name.trim();
  let slug = slugify(trimmedName);

  // Assicura unicità dello slug
  let counter = 1;
  const baseSlug = slug;
  let existing = (await query(
    `SELECT id FROM forms WHERE site_id = $1 AND slug = $2`,
    [siteId, slug]
  )).rows[0];
  while (existing) {
    slug = `${baseSlug}-${counter}`;
    counter++;
    existing = (await query(
      `SELECT id FROM forms WHERE site_id = $1 AND slug = $2`,
      [siteId, slug]
    )).rows[0];
  }

  const row = (await query(
    `INSERT INTO forms (site_id, slug, name, fields)
     VALUES ($1, $2, $3, '[]')
     RETURNING *`,
    [siteId, slug, trimmedName]
  )).rows[0];

  return serializeForm(row, locationId);
}

export async function updateForm(siteId, externalId, input = {}, locationId = null) {
  const formId = await resolveFormInternalId(siteId, externalId);
  if (!formId) return null;

  const updates = [];
  const params = [];
  let paramCounter = 1;

  if (input.name !== undefined && input.name !== null) {
    const trimmedName = input.name.trim();
    if (trimmedName) {
      updates.push(`name = $${paramCounter++}`);
      params.push(trimmedName);
    }
  }

  if (updates.length === 0) {
    // Se nessun campo da aggiornare, ritorna il form attuale
    return getForm(siteId, externalId, locationId);
  }

  updates.push(`updated_at = NOW()`);
  params.push(siteId, formId);

  const row = (await query(
    `UPDATE forms
     SET ${updates.join(", ")}
     WHERE site_id = $${paramCounter} AND id = $${paramCounter + 1}
     RETURNING *`,
    params
  )).rows[0];

  return row ? serializeForm(row, locationId) : null;
}

export async function deleteForm(siteId, externalId) {
  const formId = await resolveFormInternalId(siteId, externalId);
  if (!formId) return 0;

  const result = (await query(
    `DELETE FROM forms WHERE site_id = $1 AND id = $2`,
    [siteId, formId]
  ));
  return result.rowCount;
}

export async function listSubmissions(siteId, filters = {}, locationId = null) {
  const params = [siteId];
  let where = "fs.site_id = $1";

  // Filtro formIds (CSV di uuid)
  if (filters.formIds && filters.formIds.length > 0) {
    const formInternalIds = await Promise.all(
      filters.formIds.map(uuid => resolveFormInternalId(siteId, uuid))
    );
    const validIds = formInternalIds.filter(id => id !== null);
    if (validIds.length === 0) {
      return { submissions: [], total: 0, nextStartAfterId: null };
    }
    params.push(validIds);
    where += ` AND fs.form_id = ANY($${params.length}::integer[])`;
  }

  // Filtri date
  if (filters.startDate) {
    params.push(filters.startDate);
    where += ` AND fs.created_at >= $${params.length}`;
  }
  if (filters.endDate) {
    params.push(filters.endDate);
    where += ` AND fs.created_at < $${params.length}`;
  }

  // Count totale
  const countRow = (await query(
    `SELECT COUNT(*)::int AS cnt FROM form_submissions fs WHERE ${where}`,
    params
  )).rows[0];
  const total = countRow?.cnt || 0;

  // Lista con paginazione cursore
  let limit = filters.limit || 20;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  let orderClause = "ORDER BY fs.created_at DESC";
  if (filters.startAfterId) {
    const afterRow = (await query(
      `SELECT id FROM form_submissions WHERE external_id = $1 AND site_id = $2`,
      [filters.startAfterId, siteId]
    )).rows[0];
    if (afterRow) {
      params.push(afterRow.id);
      where += ` AND fs.id < $${params.length}`;
    }
  }

  params.push(limit + 1);
  const limitParam = params.length;
  const rows = (await query(
    `SELECT fs.*,
            f.external_id AS form_id_ext,
            c.external_id AS contact_id_ext
     FROM form_submissions fs
     LEFT JOIN forms f ON f.id = fs.form_id
     LEFT JOIN contacts c ON c.id = fs.contact_id
     WHERE ${where} ${orderClause} LIMIT $${limitParam}`,
    params
  )).rows;

  let nextStartAfterId = null;
  let items = rows.slice(0, limit);
  if (rows.length > limit) {
    nextStartAfterId = rows[limit].external_id;
  }

  const submissions = items.map(row => serializeSubmission(row, locationId));
  return { submissions, total, nextStartAfterId };
}
