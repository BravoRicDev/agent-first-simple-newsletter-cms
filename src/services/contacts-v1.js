import { query } from "../db.js";
import { logger } from "./logger.js";
import {
  getCustomValues, setCustomValues, mergeCustomValues, clearCustomValues,
} from "./custom-values.js";

// ─────────────────────────────────────────────────────────────────────────
// ONDA 1 — Contatti, surface API /v1 ("API compatibili con CRM diffusi").
//
// Il profilo standard del contatto (name, firstName, lastName, phone,
// companyName, website) + i custom field utente vivono in
// `contact_custom_values` con object_key='contact' (vedi custom-values.js).
// I campi nativi della tabella `contacts` (tags, status, notes,
// value_estimate, is_client, client_status, created_at, updated_at) restano
// nella tabella.
//
// Non tocca le firme di src/services/contacts.js (usate altrove).
// ─────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function serializeContact(row, customValues = {}) {
  if (!row) return null;
  const profile = {
    name: customValues.name ?? "",
    firstName: customValues.firstName ?? "",
    lastName: customValues.lastName ?? "",
    phone: customValues.phone ?? "",
    companyName: customValues.companyName ?? "",
    website: customValues.website ?? "",
  };
  // I custom field veri e propri: tutto fuori dalle chiavi di profilo.
  const custom = {};
  for (const [k, v] of Object.entries(customValues || {})) {
    if (!["name", "firstName", "lastName", "phone", "companyName", "website"].includes(k)) custom[k] = v;
  }
  return {
    id: row.id,
    email: row.email,
    ...profile,
    tags: row.tags || [],
    status: row.status || "",
    notes: row.notes || "",
    value_estimate: row.value_estimate !== null && row.value_estimate !== undefined ? Number(row.value_estimate) : null,
    is_client: !!row.is_client,
    client_status: row.client_status || "inactive",
    customFields: custom,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function emit(siteId, email, eventType, payload) {
  import("./events.js").then(({ emitContactEvent }) =>
    emitContactEvent(siteId, email, eventType, payload)
  ).catch((err) => logger.error(`event emit fallito (${eventType}): ${err.message}`));
}

async function resolveCustomValues(siteId, contactId) {
  const v = await getCustomValues(siteId, contactId, "contact");
  return v;
}

// Crea un contatto. `data` può contenere: name, firstName, lastName, phone,
// companyName, website, tags, status, notes, value_estimate, customFields{},
// email (obbligatoria). Ritorna il contatto serializzato o null se email
// mancante/duplicata.
export async function createContact(siteId, data = {}) {
  const email = normalizeEmail(data.email);
  if (!EMAIL_RE.test(email)) return null;

  const exists = (await query("SELECT id FROM contacts WHERE site_id = $1 AND email = $2", [siteId, email])).rows[0];
  if (exists) return { contact: null, created: false, duplicateId: exists.id };

  const tags = Array.isArray(data.tags) ? data.tags : [];
  const status = String(data.status || "").slice(0, 100);
  const notes = String(data.notes || "").slice(0, 5000);
  const value_estimate = data.value_estimate !== undefined && data.value_estimate !== null && data.value_estimate !== ""
    ? Number(data.value_estimate) : null;

  const row = (await query(
    `INSERT INTO contacts (site_id, email, tags, status, notes, value_estimate)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [siteId, email, tags, status, notes, Number.isFinite(value_estimate) ? value_estimate : null]
  )).rows[0];

  // Profilo + custom field (object_key='contact').
  // Se non vengono forniti firstName/lastName espliciti, li deriviamo dal
  // nome completo (prima parola = firstName, resto = lastName).
  const { firstName: fName, lastName: lName } = splitName(data.name);
  const profileAndCustom = {
    name: data.name,
    firstName: data.firstName ?? fName,
    lastName: data.lastName ?? lName,
    phone: data.phone, companyName: data.companyName, website: data.website,
  };
  const customValues = { ...data.customFields };
  const combined = { ...profileAndCustom, ...customValues };
  // Rimuovi undefined/null per pulizia.
  const cleanCombined = {};
  for (const [k, v] of Object.entries(combined)) {
    if (v !== undefined && v !== null && v !== "") cleanCombined[k] = v;
  }
  if (Object.keys(cleanCombined).length > 0) {
    await setCustomValues(siteId, row.id, "contact", cleanCombined);
  }

  emit(siteId, email, "contact_created", {
    contact_id: row.id, email, name: cleanCombined.name || "", tags,
  });
  return { contact: serializeContact(row, await resolveCustomValues(siteId, row.id)), created: true, duplicateId: null };
}

export async function findContactByEmail(siteId, email) {
  const normalized = normalizeEmail(email);
  const row = (await query(
    "SELECT * FROM contacts WHERE site_id = $1 AND LOWER(email) = $2",
    [siteId, normalized]
  )).rows[0];
  if (!row) return null;
  return serializeContact(row, await resolveCustomValues(siteId, row.id));
}

export async function getContact(siteId, id) {
  const row = (await query(
    "SELECT * FROM contacts WHERE site_id = $1 AND id = $2",
    [siteId, parseInt(id, 10)]
  )).rows[0];
  if (!row) return null;
  return serializeContact(row, await resolveCustomValues(siteId, row.id));
}

export async function updateContact(siteId, id, data = {}) {
  const row = (await query(
    "SELECT * FROM contacts WHERE site_id = $1 AND id = $2",
    [siteId, parseInt(id, 10)]
  )).rows[0];
  if (!row) return null;

  const next = {};
  if (data.email !== undefined && normalizeEmail(data.email)) next.email = normalizeEmail(data.email);
  if (data.name !== undefined) next.name = data.name;
  if (data.firstName !== undefined) next.firstName = data.firstName;
  if (data.lastName !== undefined) next.lastName = data.lastName;
  if (data.phone !== undefined) next.phone = data.phone;
  if (data.companyName !== undefined) next.companyName = data.companyName;
  if (data.website !== undefined) next.website = data.website;
  if (data.tags !== undefined) next.tags = Array.isArray(data.tags) ? data.tags : row.tags;
  if (data.status !== undefined) next.status = String(data.status || "").slice(0, 100);
  if (data.notes !== undefined) next.notes = String(data.notes || "").slice(0, 5000);
  if (data.value_estimate !== undefined) {
    const v = data.value_estimate === "" || data.value_estimate === null ? null : Number(data.value_estimate);
    next.value_estimate = Number.isFinite(v) ? v : null;
  }
  if (data.is_client !== undefined) next.is_client = data.is_client === true || data.is_client === "true";
  if (data.client_status !== undefined) next.client_status = String(data.client_status || "inactive").slice(0, 20);

  // Se cambia 'name' senza firstName/lastName espliciti, ri-deriviamoli dal
  // nuovo nome completo (coerente con createContact e serializeContact).
  if (next.name !== undefined && next.firstName === undefined && next.lastName === undefined) {
    const { firstName: fName, lastName: lName } = splitName(next.name);
    next.firstName = fName;
    next.lastName = lName;
  }

  // Aggiorna colonne native contacts.
  const native = {};
  if (next.email !== undefined) native.email = next.email;
  if (next.tags !== undefined) native.tags = next.tags;
  if (next.status !== undefined) native.status = next.status;
  if (next.notes !== undefined) native.notes = next.notes;
  if (next.value_estimate !== undefined) native.value_estimate = next.value_estimate;
  if (next.is_client !== undefined) native.is_client = next.is_client;
  if (next.client_status !== undefined) native.client_status = next.client_status;

  if (Object.keys(native).length > 0) {
    const sets = Object.keys(native).map((k, i) => `${k} = $${i + 1}`).join(", ");
    const vals = [...Object.values(native), parseInt(id, 10), siteId];
    await query(`UPDATE contacts SET ${sets}, updated_at = NOW() WHERE id = $${vals.length - 1} AND site_id = $${vals.length}`, vals);
  }

  // Profilo/custom field in custom values (chiavi non-native).
  const profileAndCustom = {};
  for (const k of ["name", "firstName", "lastName", "phone", "companyName", "website"]) {
    if (next[k] !== undefined) profileAndCustom[k] = next[k];
  }
  if (data.customFields && typeof data.customFields === "object") {
    Object.assign(profileAndCustom, data.customFields);
  }
  // anche custom field top-level (fuori da customFields) sul contatto
  if (Object.keys(profileAndCustom).length > 0) {
    await mergeCustomValues(siteId, row.id, "contact", profileAndCustom);
  }

  const updated = await getContact(siteId, id);
  emit(siteId, updated.email, "contact_updated", { contact_id: updated.id, email: updated.email });
  return updated;
}

export async function deleteContact(siteId, id) {
  const row = (await query(
    "SELECT id FROM contacts WHERE site_id = $1 AND id = $2",
    [siteId, parseInt(id, 10)]
  )).rows[0];
  if (!row) return null;
  await clearCustomValues(siteId, row.id);
  await query("DELETE FROM contacts WHERE id = $1 AND site_id = $2", [row.id, siteId]);
  return row.id;
}

// Upsert per email. Ritorna { contact, created }.
export async function upsertContactByEmail(siteId, email, data = {}) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) return { contact: null, created: false };
  const existing = (await query(
    "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = $2",
    [siteId, normalized]
  )).rows[0];
  if (existing) {
    const updated = await updateContact(siteId, existing.id, { ...data, email: normalized });
    return { contact: updated, created: false };
  }
  const res = await createContact(siteId, { ...data, email: normalized });
  return { contact: res?.contact || null, created: !!res?.created };
}

export async function listContacts(siteId, { limit = 25, offset = 0, query: q = null, tag = null, status = null } = {}) {
  const params = [siteId];
  let where = "c.site_id = $1";
  if (tag) { params.push(tag); where += " AND $2 = ANY(c.tags)"; }
  if (status) { params.push(String(status).slice(0, 100)); where += ` AND c.status = $${params.length}`; }
  if (q) {
    params.push(`%${String(q)}%`);
    where += ` AND (c.email ILIKE $${params.length} OR c.notes ILIKE $${params.length} OR COALESCE(cv.values::text, '') ILIKE $${params.length})`;
  }
  params.push(Math.min(parseInt(limit, 10) || 25, 200), Math.max(parseInt(offset, 10) || 0, 0));

  const countRow = (await query(
    `SELECT COUNT(*)::int AS n FROM contacts c
     LEFT JOIN contact_custom_values cv ON cv.site_id = c.site_id AND cv.contact_id = c.id AND cv.object_key = 'contact'
     WHERE ${where}`,
    params.slice(0, params.length - 2)
  )).rows[0];

  const rows = (await query(
    `SELECT c.* FROM contacts c
     LEFT JOIN contact_custom_values cv ON cv.site_id = c.site_id AND cv.contact_id = c.id AND cv.object_key = 'contact'
     WHERE ${where}
     ORDER BY c.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )).rows;

  const contacts = [];
  for (const r of rows) contacts.push(serializeContact(r, await resolveCustomValues(siteId, r.id)));
  return { contacts, total: countRow.n };
}

export async function searchContacts(siteId, { query: q = "", tag = null } = {}) {
  const res = await listContacts(siteId, { limit: 200, query: q || null, tag });
  return res;
}

// Ricerca duplicati: stessa email, oppure nome/phone fuzzy (case-insensitive).
export async function findDuplicateContacts(siteId, { email = null, name = null, phone = null } = {}) {
  const params = [siteId];
  const ors = [];
  if (email && EMAIL_RE.test(String(email))) {
    params.push(normalizeEmail(email));
    ors.push(`c.email = $${params.length}`);
  }
  if (name && String(name).trim()) {
    params.push(`%${String(name).trim().toLowerCase()}%`);
    ors.push(`(cv.values->>'name') ILIKE $${params.length}`);
  }
  if (phone && String(phone).trim()) {
    params.push(`%${String(phone).trim()}%`);
    ors.push(`(cv.values->>'phone') ILIKE $${params.length}`);
  }
  if (ors.length === 0) return [];

  const rows = (await query(
    `SELECT c.* FROM contacts c
     LEFT JOIN contact_custom_values cv ON cv.site_id = c.site_id AND cv.contact_id = c.id AND cv.object_key = 'contact'
     WHERE c.site_id = $1 AND (${ors.join(" OR ")})`,
    params
  )).rows;
  const dupes = [];
  for (const r of rows) dupes.push(serializeContact(r, await resolveCustomValues(siteId, r.id)));
  return dupes;
}

// ── Note (contact_notes usa contact_email, non id) ──────────────────────

async function contactEmail(siteId, id) {
  const row = (await query("SELECT email FROM contacts WHERE site_id = $1 AND id = $2", [siteId, parseInt(id, 10)])).rows[0];
  return row ? row.email : null;
}

export async function addContactNote(siteId, contactId, body) {
  const email = await contactEmail(siteId, contactId);
  if (!email) return null;
  const clean = String(body || "").trim();
  if (!clean) return null;
  const row = (await query(
    `INSERT INTO contact_notes (site_id, contact_email, author_type, author_name, body)
     VALUES ($1, $2, 'human', '', $3) RETURNING *`,
    [siteId, email, clean.slice(0, 5000)]
  )).rows[0];
  return row;
}

export async function listContactNotes(siteId, contactId) {
  const email = await contactEmail(siteId, contactId);
  if (!email) return [];
  return (await query(
    "SELECT id, body, author_type, author_name, created_at FROM contact_notes WHERE site_id = $1 AND contact_email = $2 ORDER BY created_at DESC",
    [siteId, email]
  )).rows;
}

export async function deleteContactNote(siteId, noteId) {
  const row = (await query(
    "DELETE FROM contact_notes WHERE id = $1 AND site_id = $2 RETURNING id",
    [parseInt(noteId, 10), siteId]
  )).rows[0];
  return row ? row.id : null;
}

// ── Tags ────────────────────────────────────────────────────────────────

export async function listContactTags(siteId, contactId) {
  const row = (await query("SELECT tags FROM contacts WHERE site_id = $1 AND id = $2", [siteId, parseInt(contactId, 10)])).rows[0];
  return row ? (row.tags || []) : null;
}

export async function addContactTags(siteId, contactId, tagsInput) {
  const row = (await query("SELECT email, tags FROM contacts WHERE site_id = $1 AND id = $2", [siteId, parseInt(contactId, 10)])).rows[0];
  if (!row) return null;
  const incoming = Array.isArray(tagsInput) ? tagsInput : (String(tagsInput || "").split(","));
  const clean = incoming.map((t) => String(t).trim().slice(0, 100)).filter(Boolean);
  const merged = [...new Set([...(row.tags || []), ...clean])];
  await query("UPDATE contacts SET tags = $1, updated_at = NOW() WHERE site_id = $2 AND id = $3", [merged, siteId, parseInt(contactId, 10)]);
  return merged;
}

export async function removeContactTag(siteId, contactId, tag) {
  const row = (await query("SELECT tags FROM contacts WHERE site_id = $1 AND id = $2", [siteId, parseInt(contactId, 10)])).rows[0];
  if (!row) return null;
  const cleanTag = String(tag || "").trim();
  const merged = (row.tags || []).filter((t) => t !== cleanTag);
  await query("UPDATE contacts SET tags = $1, updated_at = NOW() WHERE site_id = $2 AND id = $3", [merged, siteId, parseInt(contactId, 10)]);
  return merged;
}
