import { query } from "../db.js";
import { emitContactEvent } from "./events.js";
import { getExternalId, findByAnyId, publicId } from "./external-ids.js";
import { getCustomValues, setCustomValues, mergeCustomValues } from "./custom-values.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Allowlist colonne ordinabili per /contacts/search: mappa il campo esposto
// (stile GHL, camelCase) sulla colonna reale QUALIFICATA della query (alias
// c = contacts). field e direction NON vengono mai interpolati direttamente
// in SQL: solo costanti presenti qui e solo "ASC"/"DESC", così non c'è
// superficie di injection. Colonne verificate nello schema `contacts`
// (db/025_contacts.sql): created_at / updated_at.
const SORTABLE_COLUMNS = {
  dateAdded: "c.created_at",
  dateUpdated: "c.updated_at",
};

// Costruisce l'ORDER BY dall'array sort stile GHL [{ field, direction }].
// Entry con field fuori allowlist o direction non "asc"/"desc" vengono
// ignorate; se nessuno sort valido resta, si ricade sul default storico
// "c.id DESC" (così GET /contacts — che non manda mai sort — è invariato).
function buildOrderBy(sort) {
  if (!Array.isArray(sort) || sort.length === 0) return "c.id DESC";
  const clauses = [];
  for (const entry of sort) {
    const col = SORTABLE_COLUMNS[entry?.field];
    if (!col) continue;
    const dir = typeof entry?.direction === "string" ? entry.direction.toLowerCase() : "";
    if (dir !== "asc" && dir !== "desc") continue;
    clauses.push(`${col} ${dir.toUpperCase()}`);
  }
  return clauses.length > 0 ? clauses.join(", ") : "c.id DESC";
}

// Chiavi che NON sono custom field GHL: profilo + campi top-level del contatto.
// Vanno escluse dall'array customFields (in GHL sono campi separati, non custom).
const NON_CUSTOM_KEYS = new Set([
  "name", "firstName", "lastName", "phone", "companyName", "website",
  "address", "address1", "city", "state", "postalCode", "country", "timezone",
]);

// Risolve un field_key a partire da un id o key passata in ingresso.
// Query su custom_fields WHERE site_id=$1 AND object_key='contact' AND active=true
// AND (ghl_id=$2 OR external_id::text=$2 OR field_key=$2), ritorna field_key
// se trovato altrimenti null.
async function resolveCustomFieldKey(siteId, idOrKey) {
  const rows = (await query(
    "SELECT field_key FROM custom_fields WHERE site_id = $1 AND object_key = 'contact' AND active = true AND (ghl_id = $2 OR external_id::text = $2 OR field_key = $2)",
    [siteId, idOrKey]
  )).rows;
  return rows.length > 0 ? rows[0].field_key : null;
}

// Costruisce customFields nello SHAPE REALE di GHL: [{ id, value }] dove id è il
// ghl_id VERO del custom field (non il nostro UUID external_id — era il bug: si
// usava external_id e si aggiungevano key/field_value, campi che in GHL non
// esistono). Per un campo sincronizzato ghl_id è sempre valorizzato; fallback a
// external_id solo per definizioni locali mai sincronizzate (assenti in GHL).
function buildCustomFields(customValues = {}, customFieldDefs = []) {
  const map = new Map(customFieldDefs.map((f) => [f.field_key, f]));
  const out = [];
  for (const [k, v] of Object.entries(customValues || {})) {
    if (NON_CUSTOM_KEYS.has(k)) continue;
    const def = map.get(k);
    if (!def) continue;
    out.push({ id: def.ghl_id || def.external_id, value: v });
  }
  return out;
}

// row.ghl_contact_raw è JSONB (pg lo restituisce già oggetto); tollera anche
// una stringa e l'assenza (riga non ancora ri-sincronizzata).
function parseRaw(v) {
  if (!v) return {};
  if (typeof v === "string") { try { return JSON.parse(v) || {}; } catch { return {}; } }
  return typeof v === "object" ? v : {};
}
// Stringa: null se vuota/assente (GHL usa null, non "").
function nn(v) { return v === "" || v === undefined || v === null ? null : v; }
// Prendi dal raw (autoritativo, mirror GHL) se la chiave c'è; altrimenti fallback.
function pick(raw, key, fallback) {
  return raw && Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : fallback;
}

export async function serializeContact(row, customValues = {}, customFieldDefs = []) {
  if (!row) return null;

  const generatedExtId = await getExternalId("contacts", row.id);
  const id = publicId(row) || generatedExtId;

  // Profilo contatto (name, firstName, lastName, phone, companyName, website).
  const profile = {
    firstName: customValues.firstName ?? "",
    lastName: customValues.lastName ?? "",
    phone: customValues.phone ?? "",
    companyName: customValues.companyName ?? "",
    website: customValues.website ?? "",
  };

  // Custom field nello shape reale di GHL: [{ id: <ghl_id>, value }].
  const customFieldsArray = buildCustomFields(customValues, customFieldDefs);

  return {
    id: id,
    locationId: row.location_external_id || null,
    firstName: profile.firstName,
    lastName: profile.lastName,
    companyName: profile.companyName,
    phone: profile.phone,
    email: row.email,
    address1: customValues.address1 ?? "",
    city: customValues.city ?? "",
    state: customValues.state ?? "",
    postalCode: customValues.postalCode ?? "",
    country: customValues.country ?? "",
    website: profile.website,
    timezone: customValues.timezone ?? "",
    tags: row.tags || [],
    customFields: customFieldsArray,
    dateAdded: row.created_at?.toISOString() || null,
    dateUpdated: row.updated_at?.toISOString() || null,
  };
}

// Serializer DEDICATO per POST /contacts/search: produce lo shape ESATTO del
// contatto nella risposta reale di GHL a questo endpoint (vedi
// .tmp-compare/ghl-real-francesco.json). NON tocca serializeContact (usato da
// GET /contacts e GET /contacts/:id, che hanno un altro shape). Campi letti dal
// raw GHL persistito dal sync (db/130) quando presente, con fallback sensati;
// null dove GHL usa null (non stringa vuota); opportunities/followers/
// attributionSource/additionalEmails/... dal raw (già nel payload di
// /contacts/search, nessuna chiamata extra). customFields con il ghl_id reale.
export async function serializeContactSearch(row, customValues = {}, customFieldDefs = []) {
  if (!row) return null;
  const generatedExtId = await getExternalId("contacts", row.id);
  const id = publicId(row) || generatedExtId;
  const raw = parseRaw(row.ghl_contact_raw);
  const cv = customValues || {};

  const firstName = pick(raw, "firstName", cv.firstName ?? "");
  const lastName = pick(raw, "lastName", cv.lastName ?? "");
  const dateAdded = row.created_at?.toISOString() ?? pick(raw, "dateAdded", null);
  const dateUpdated = row.updated_at?.toISOString() ?? pick(raw, "dateUpdated", null);
  const searchAfter = Array.isArray(raw.searchAfter)
    ? raw.searchAfter
    : [row.created_at ? new Date(row.created_at).getTime() : null, id];

  return {
    id,
    phoneLabel: pick(raw, "phoneLabel", null),
    country: pick(raw, "country", null),
    address: pick(raw, "address", null),
    source: pick(raw, "source", null),
    type: pick(raw, "type", null),
    locationId: row.location_external_id ?? pick(raw, "locationId", null),
    website: pick(raw, "website", nn(cv.website)),
    dnd: pick(raw, "dnd", false),
    state: pick(raw, "state", null),
    businessName: pick(raw, "businessName", null),
    customFields: buildCustomFields(cv, customFieldDefs),
    tags: Array.isArray(raw.tags) ? raw.tags : (row.tags || []),
    dateAdded,
    additionalEmails: pick(raw, "additionalEmails", []),
    phone: pick(raw, "phone", nn(cv.phone)),
    companyName: pick(raw, "companyName", nn(cv.companyName)),
    additionalPhones: pick(raw, "additionalPhones", []),
    dateUpdated,
    city: pick(raw, "city", null),
    dateOfBirth: pick(raw, "dateOfBirth", null),
    firstNameLowerCase: pick(raw, "firstNameLowerCase", (firstName || "").toLowerCase()),
    lastNameLowerCase: pick(raw, "lastNameLowerCase", (lastName || "").toLowerCase()),
    firstName,
    lastName,
    contactName: pick(raw, "contactName", `${firstName} ${lastName}`.trim().toLowerCase()),
    email: row.email ?? pick(raw, "email", null),
    assignedTo: pick(raw, "assignedTo", null),
    followers: pick(raw, "followers", []),
    validEmail: pick(raw, "validEmail", null),
    dndSettings: pick(raw, "dndSettings", {}),
    opportunities: pick(raw, "opportunities", []),
    postalCode: pick(raw, "postalCode", null),
    businessId: pick(raw, "businessId", null),
    searchAfter,
    timezone: pick(raw, "timezone", nn(cv.timezone)),
    inboundDndSettings: pick(raw, "inboundDndSettings", {}),
    attributionSource: pick(raw, "attributionSource", null),
    lastAttributionSource: pick(raw, "lastAttributionSource", null),
  };
}

export async function getContactCustomFields(siteId) {
  const rows = (await query(
    "SELECT id, field_key, external_id, ghl_id FROM custom_fields WHERE site_id = $1 AND object_key = 'contact' AND active = true",
    [siteId]
  )).rows;
  return rows;
}

export async function createContact(siteId, data = {}) {
  const email = normalizeEmail(data.email);
  if (!EMAIL_RE.test(email)) {
    const err = new Error("Email non valida");
    err.status = 400;
    throw err;
  }

  const exists = (await query("SELECT id FROM contacts WHERE site_id = $1 AND email = $2", [siteId, email])).rows[0];
  if (exists) {
    const err = new Error("Contatto già esistente");
    err.status = 409;
    throw err;
  }

  // Leggi location_external_id dal site.
  const siteRow = (await query("SELECT location_external_id, external_id FROM sites WHERE id = $1", [siteId])).rows[0];

  const tags = Array.isArray(data.tags) ? data.tags : [];
  const row = (await query(
    `INSERT INTO contacts (site_id, email, tags, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`,
    [siteId, email, tags]
  )).rows[0];

  // Salva custom values (address, city, state, ecc. + custom field).
  const customValues = {
    firstName: data.firstName ?? "",
    lastName: data.lastName ?? "",
    phone: data.phone ?? "",
    companyName: data.companyName ?? "",
    website: data.website ?? "",
    address1: data.address1 ?? "",
    city: data.city ?? "",
    state: data.state ?? "",
    postalCode: data.postalCode ?? "",
    country: data.country ?? "",
    timezone: data.timezone ?? "",
  };

  // Merge custom field utente se presenti.
  // I campi possono arrivare in due formati:
  // 1) Formato GHL reale: { id: "<ghl_id>", value: "..." } — qui id è il ghl_id vero
  // 2) Formato interno legacy: { key: "<field_key>", field_value: "..." }
  // Risolviamo sempre tramite resolveCustomFieldKey che accetta sia ghl_id che external_id che field_key.
  if (Array.isArray(data.customFields)) {
    for (const cf of data.customFields) {
      let fieldKey;
      if (cf.id) {
        // Formato GHL/esterno: usa id (può essere ghl_id o external_id/UUID interno)
        fieldKey = await resolveCustomFieldKey(siteId, cf.id);
      }
      if (!fieldKey && cf.key) {
        // Fallback retrocompatibilità: usa key
        fieldKey = await resolveCustomFieldKey(siteId, cf.key);
      }
      if (fieldKey) {
        customValues[fieldKey] = cf.value ?? cf.field_value ?? "";
      } else {
        console.warn(`customField: impossibile risolvere key/id "${cf.id || cf.key}" — entry ignorata`);
      }
    }
  }

  await setCustomValues(siteId, row.id, "contact", customValues);

  // locationId canonico clone: location_external_id ?? sites.external_id
  row.location_external_id = siteRow?.location_external_id || siteRow?.external_id || null;
  const fieldDefs = await getContactCustomFields(siteId);

  // Evento CRM (workflow/scoring/webhook OUT): stesso emettitore del flusso legacy
  emitContactEvent(siteId, row.email, "contact_created", { source: "api" }).catch(() => {});

  return serializeContact(row, customValues, fieldDefs);
}

export async function getContact(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  // Leggi location_external_id dal site.
  const siteRow = (await query("SELECT location_external_id, external_id FROM sites WHERE id = $1", [siteId])).rows[0];
  contact.location_external_id = siteRow?.location_external_id || siteRow?.external_id || null;

  const customValues = await getCustomValues(siteId, contact.id, "contact");
  const fieldDefs = await getContactCustomFields(siteId);
  return serializeContact(contact, customValues, fieldDefs);
}

export async function updateContact(siteId, contactExternalId, data = {}) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const updates = {};
  const currentTags = Array.isArray(contact.tags) ? contact.tags : [];
  if (Array.isArray(data.tags)) {
    updates.tags = data.tags;
  }

  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date();
    const setClauses = [];
    const values = [];
    let paramIdx = 1;
    for (const [k, v] of Object.entries(updates)) {
      setClauses.push(`${k} = $${paramIdx}`);
      values.push(v);
      paramIdx++;
    }
    values.push(contact.id);
    await query(
      `UPDATE contacts SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values
    );
  }

  // Merge custom values.
  const currentCustom = await getCustomValues(siteId, contact.id, "contact");
  const mergeData = {};
  if (data.firstName !== undefined) mergeData.firstName = data.firstName;
  if (data.lastName !== undefined) mergeData.lastName = data.lastName;
  if (data.phone !== undefined) mergeData.phone = data.phone;
  if (data.companyName !== undefined) mergeData.companyName = data.companyName;
  if (data.website !== undefined) mergeData.website = data.website;
  if (data.address1 !== undefined) mergeData.address1 = data.address1;
  if (data.city !== undefined) mergeData.city = data.city;
  if (data.state !== undefined) mergeData.state = data.state;
  if (data.postalCode !== undefined) mergeData.postalCode = data.postalCode;
  if (data.country !== undefined) mergeData.country = data.country;
  if (data.timezone !== undefined) mergeData.timezone = data.timezone;

  if (Array.isArray(data.customFields)) {
    for (const cf of data.customFields) {
      let fieldKey;
      if (cf.id) {
        // Formato GHL/esterno: usa id (può essere ghl_id o external_id/UUID interno)
        fieldKey = await resolveCustomFieldKey(siteId, cf.id);
      }
      if (!fieldKey && cf.key) {
        // Fallback retrocompatibilità: usa key
        fieldKey = await resolveCustomFieldKey(siteId, cf.key);
      }
      if (fieldKey) {
        mergeData[fieldKey] = cf.value ?? cf.field_value ?? "";
      } else {
        console.warn(`customField: impossibile risolvere key/id "${cf.id || cf.key}" — entry ignorata`);
      }
    }
  }

  const newCustom = { ...currentCustom, ...mergeData };
  if (Object.keys(mergeData).length > 0) {
    await setCustomValues(siteId, contact.id, "contact", newCustom);
  }

  const refreshed = (await query("SELECT * FROM contacts WHERE id = $1", [contact.id])).rows[0];
  const siteRow = (await query("SELECT location_external_id, external_id FROM sites WHERE id = $1", [siteId])).rows[0];
  refreshed.location_external_id = siteRow?.location_external_id || siteRow?.external_id || null;

  const fieldDefs = await getContactCustomFields(siteId);

  // Eventi CRM: contact_updated + tag_added per ogni nuovo tag
  emitContactEvent(siteId, refreshed.email, "contact_updated", { source: "api" }).catch(() => {});
  const before = Array.isArray(currentTags) ? currentTags : [];
  const after = Array.isArray(refreshed.tags) ? refreshed.tags : [];
  for (const t of after) {
    if (!before.includes(t)) {
      emitContactEvent(siteId, refreshed.email, "tag_added", { tag: t }).catch(() => {});
    }
  }

  return serializeContact(refreshed, newCustom, fieldDefs);
}

export async function deleteContact(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  await query("DELETE FROM contacts WHERE id = $1", [contact.id]);
  return true;
}

export async function listContacts(siteId, filters = {}, serialize = serializeContact) {
  const { limit = 20, startAfterId = null, query: searchQuery = null, tag = null, email = null, sort = null } = filters;

  let whereClause = "c.site_id = $1";
  const params = [siteId];
  let paramIdx = 2;

  if (searchQuery) {
    whereClause += ` AND (c.email ILIKE $${paramIdx} OR c.external_id::text ILIKE $${paramIdx})`;
    params.push(`%${searchQuery}%`);
    paramIdx++;
  }
  if (tag) {
    whereClause += ` AND $${paramIdx} = ANY(c.tags)`;
    params.push(tag);
    paramIdx++;
  }
  if (email) {
    whereClause += ` AND c.email = $${paramIdx}`;
    params.push(normalizeEmail(email));
    paramIdx++;
  }

  // Conta totale (senza filtro di paginazione).
  const countRes = (await query(
    `SELECT COUNT(*) as total FROM contacts c WHERE ${whereClause}`,
    params.slice(0, paramIdx)
  )).rows[0];
  const total = parseInt(countRes.total, 10);

  // Aggiungi filtro di paginazione se presente.
  let paginationWhereClause = whereClause;
  const paginationParams = [...params];
  let paginationParamIdx = paramIdx;

  if (startAfterId) {
    const afterContact = await findByAnyId("contacts", siteId, startAfterId);
    if (afterContact && afterContact.site_id === siteId) {
      paginationWhereClause += ` AND c.id < $${paginationParamIdx}`;
      paginationParams.push(afterContact.id);
      paginationParamIdx++;
    }
  }

  paginationParams.push(limit + 1);
  const orderBy = buildOrderBy(sort);
  const querySql = `
    SELECT c.*, s.location_external_id
    FROM contacts c
    LEFT JOIN sites s ON c.site_id = s.id
    WHERE ${paginationWhereClause}
    ORDER BY ${orderBy} LIMIT $${paginationParamIdx}
  `;

  const rows = (await query(querySql, paginationParams)).rows;

  const contacts = [];
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    const row = rows[i];
    const customValues = await getCustomValues(siteId, row.id, "contact");
    const fieldDefs = await getContactCustomFields(siteId);
    const serialized = await serialize(row, customValues, fieldDefs);
    contacts.push(serialized);
  }

  let nextStartAfterId = null;
  if (rows.length > limit) {
    const cursorRow = rows[limit];
    const generatedNextId = await getExternalId("contacts", cursorRow.id);
    nextStartAfterId = publicId(cursorRow) || generatedNextId;
  }

  return { contacts, total, nextStartAfterId };
}

export async function searchContacts(siteId, filters = {}) {
  // Serializer DEDICATO: /contacts/search deve essere byte-identico a GHL
  // (shape diverso da serializeContact usato da GET /contacts e GET /contacts/:id).
  return listContacts(siteId, filters, serializeContactSearch);
}

export async function upsertContact(siteId, data = {}) {
  const email = normalizeEmail(data.email);
  if (!EMAIL_RE.test(email)) {
    const err = new Error("Email non valida");
    err.status = 400;
    throw err;
  }

  const existing = (await query("SELECT id, ghl_id, external_id FROM contacts WHERE site_id = $1 AND email = $2", [siteId, email])).rows[0];

  if (existing) {
    // UPDATE
    const updateId = publicId(existing) || (await getExternalId("contacts", existing.id));
    return { contact: await updateContact(siteId, updateId, data), created: false };
  } else {
    // CREATE
    return { contact: await createContact(siteId, data), created: true };
  }
}

export async function findDuplicates(siteId) {
  const rows = (await query(
    `SELECT email, COUNT(*) as cnt FROM contacts
     WHERE site_id = $1 GROUP BY email HAVING COUNT(*) > 1`,
    [siteId]
  )).rows;

  const results = [];
  for (const row of rows) {
    const contacts = (await query(
      "SELECT * FROM contacts WHERE site_id = $1 AND email = $2",
      [siteId, row.email]
    )).rows;
    for (const contact of contacts) {
      const customValues = await getCustomValues(siteId, contact.id, "contact");
      const fieldDefs = await getContactCustomFields(siteId);
      const siteRow = (await query("SELECT location_external_id, external_id FROM sites WHERE id = $1", [siteId])).rows[0];
      contact.location_external_id = siteRow?.location_external_id || siteRow?.external_id || null;
      results.push(await serializeContact(contact, customValues, fieldDefs));
    }
  }

  return results;
}

// ── Note subresource ──────────────────────────────────────────────────────

export async function serializeNote(row) {
  if (!row) return null;
  const generatedId = await getExternalId("contact_notes", row.id);
  const id = publicId(row) || generatedId;
  let userId = null;
  if (row.user_id) {
    const userRow = (await query("SELECT ghl_id, external_id FROM users WHERE id = $1", [row.user_id])).rows[0];
    userId = publicId(userRow) || (await getExternalId("users", row.user_id));
  }
  let contactId = null;
  if (row.contact_id) {
    const contactRow = (await query("SELECT ghl_id, external_id FROM contacts WHERE id = $1", [row.contact_id])).rows[0];
    contactId = publicId(contactRow) || (await getExternalId("contacts", row.contact_id));
  }
  return {
    id,
    body: row.body || "",
    userId,
    contactId,
    dateAdded: row.created_at?.toISOString() || null,
    dateUpdated: row.updated_at?.toISOString() || null,
  };
}

export async function getContactNotes(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const rows = (await query(
    "SELECT * FROM contact_notes WHERE site_id = $1 AND contact_id = $2 ORDER BY created_at DESC",
    [siteId, contact.id]
  )).rows;

  return Promise.all(rows.map(r => serializeNote(r)));
}

export async function createContactNote(siteId, contactExternalId, data = {}) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const body = String(data.body || "").trim();
  if (!body) {
    const err = new Error("Body obbligatorio");
    err.status = 400;
    throw err;
  }

  let userId = null;
  if (data.userId) {
    const user = (await query(
      "SELECT id FROM users WHERE site_id = $1 AND external_id = $2",
      [siteId, data.userId]
    )).rows[0];
    if (!user) {
      const err = new Error("Utente non trovato");
      err.status = 400;
      throw err;
    }
    userId = user.id;
  }

  const row = (await query(
    "INSERT INTO contact_notes (site_id, contact_email, contact_id, user_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NULL) RETURNING *",
    [siteId, contact.email, contact.id, userId, body]
  )).rows[0];

  return serializeNote(row);
}

export async function updateContactNote(siteId, contactExternalId, noteExternalId, data = {}) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const note = await findByAnyId("contact_notes", siteId, noteExternalId);
  if (!note || note.contact_id !== contact.id) {
    const err = new Error("Nota non trovata");
    err.status = 404;
    throw err;
  }

  const body = String(data.body || "").trim();
  if (!body) {
    const err = new Error("Body obbligatorio");
    err.status = 400;
    throw err;
  }

  const updated = (await query(
    "UPDATE contact_notes SET body = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [body, note.id]
  )).rows[0];

  return serializeNote(updated);
}

export async function deleteContactNote(siteId, contactExternalId, noteExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const note = await findByAnyId("contact_notes", siteId, noteExternalId);
  if (!note || note.contact_id !== contact.id) {
    const err = new Error("Nota non trovata");
    err.status = 404;
    throw err;
  }

  const result = await query(
    "DELETE FROM contact_notes WHERE id = $1",
    [note.id]
  );
  return result.rowCount > 0;
}

// ── Task subresource ──────────────────────────────────────────────────────

export async function serializeTask(row) {
  if (!row) return null;
  const generatedId = await getExternalId("tasks", row.id);
  const id = publicId(row) || generatedId;
  let contactId = null;
  if (row.contact_id) {
    const contactRow = (await query("SELECT ghl_id, external_id FROM contacts WHERE id = $1", [row.contact_id])).rows[0];
    contactId = publicId(contactRow) || (await getExternalId("contacts", row.contact_id));
  }
  return {
    id,
    contactId,
    title: row.title || "",
    body: row.notes || "",
    dueDate: row.due_at ? new Date(row.due_at).toISOString() : null,
    completed: row.status === "done",
    reminderDate: row.reminder_date ? new Date(row.reminder_date).toISOString() : null,
    dateAdded: row.created_at?.toISOString() || null,
    dateUpdated: row.updated_at?.toISOString() || null,
  };
}

export async function getContactTasks(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const rows = (await query(
    "SELECT * FROM tasks WHERE site_id = $1 AND email = $2 ORDER BY created_at DESC",
    [siteId, contact.email]
  )).rows;

  return Promise.all(rows.map(r => serializeTask(r)));
}

export async function createContactTask(siteId, contactExternalId, data = {}) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const title = String(data.title || "").trim();
  if (!title) {
    const err = new Error("Title obbligatorio");
    err.status = 400;
    throw err;
  }

  const notes = String(data.body || "").trim();
  const dueAt = data.dueDate ? new Date(data.dueDate) : null;
  const reminderDate = data.reminderDate ? new Date(data.reminderDate) : null;

  const row = (await query(
    "INSERT INTO tasks (site_id, email, title, notes, due_at, reminder_date, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW()) RETURNING *",
    [siteId, contact.email, title, notes, dueAt, reminderDate]
  )).rows[0];

  return serializeTask(row);
}

export async function updateContactTask(siteId, contactExternalId, taskExternalId, data = {}) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const task = await findByAnyId("tasks", siteId, taskExternalId);
  if (!task || task.email !== contact.email) {
    const err = new Error("Task non trovato");
    err.status = 404;
    throw err;
  }

  const updates = {};
  if (data.title !== undefined) {
    const title = String(data.title || "").trim();
    if (!title) {
      const err = new Error("Title obbligatorio");
      err.status = 400;
      throw err;
    }
    updates.title = title;
  }
  if (data.body !== undefined) updates.notes = String(data.body || "").trim();
  if (data.dueDate !== undefined) updates.due_at = data.dueDate ? new Date(data.dueDate) : null;
  if (data.reminderDate !== undefined) updates.reminder_date = data.reminderDate ? new Date(data.reminderDate) : null;
  if (data.completed !== undefined) {
    updates.status = data.completed ? "done" : "open";
  }

  if (Object.keys(updates).length > 0) {
    const setClauses = [];
    const values = [];
    let paramIdx = 1;
    for (const [k, v] of Object.entries(updates)) {
      setClauses.push(`${k} = $${paramIdx}`);
      values.push(v);
      paramIdx++;
    }
    values.push(task.id);
    await query(
      `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values
    );
  }

  const updated = (await query("SELECT * FROM tasks WHERE id = $1", [task.id])).rows[0];
  return serializeTask(updated);
}

export async function deleteContactTask(siteId, contactExternalId, taskExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const task = await findByAnyId("tasks", siteId, taskExternalId);
  if (!task || task.email !== contact.email) {
    const err = new Error("Task non trovato");
    err.status = 404;
    throw err;
  }

  const result = await query(
    "DELETE FROM tasks WHERE id = $1",
    [task.id]
  );
  return result.rowCount > 0;
}

// ── Follower subresource ──────────────────────────────────────────────────

export async function serializeFollower(row) {
  if (!row) return null;
  return {
    id: row.external_id,
    firstName: row.name || "",
    email: row.email || "",
  };
}

export async function getContactFollowers(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const rows = (await query(
    `SELECT u.external_id, u.ghl_id, u.name, u.email FROM contact_followers cf
     JOIN users u ON u.id = cf.user_id
     WHERE cf.contact_id = $1 ORDER BY cf.created_at DESC`,
    [contact.id]
  )).rows;

  return rows.map(r => ({ id: publicId(r) || r.external_id, firstName: r.name || "", email: r.email || "" }));
}

export async function addContactFollower(siteId, contactExternalId, userExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const user = await findByAnyId("users", siteId, userExternalId);
  if (!user) {
    const err = new Error("Utente non trovato");
    err.status = 400;
    throw err;
  }

  // BUG preesistente corretto: contact_followers.site_id è NOT NULL senza
  // default e il vincolo UNIQUE reale è (site_id, contact_id, user_id) —
  // l'INSERT precedente omettendo site_id falliva SEMPRE, mascherato dal
  // try/catch vuoto (l'endpoint follower non aggiungeva mai nulla).
  await query(
    "INSERT INTO contact_followers (site_id, contact_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (site_id, contact_id, user_id) DO NOTHING",
    [siteId, contact.id, user.id]
  );

  return { id: publicId(user) || user.external_id, firstName: user.name || "", email: user.email || "" };
}

export async function removeContactFollower(siteId, contactExternalId, userExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const user = await findByAnyId("users", siteId, userExternalId);
  if (!user) {
    const err = new Error("Utente non trovato");
    err.status = 400;
    throw err;
  }

  const result = await query(
    "DELETE FROM contact_followers WHERE contact_id = $1 AND user_id = $2",
    [contact.id, user.id]
  );
  return result.rowCount > 0;
}

// ── Appointment subresource ───────────────────────────────────────────────

export async function getContactAppointments(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const rows = (await query(
    `SELECT external_id, ghl_id, title, start_time, end_time, status
     FROM booking_appointments
     WHERE site_id = $1 AND contact_email = $2
     ORDER BY start_time DESC LIMIT 50`,
    [siteId, contact.email]
  )).rows;

  return rows.map(r => ({
    id: publicId(r) || r.external_id,
    title: r.title || "",
    startTime: r.start_time?.toISOString() || null,
    endTime: r.end_time?.toISOString() || null,
    status: r.status || "confirmed",
  }));
}

// ── Email verification ────────────────────────────────────────────────────

import { verifySubscriberEmail } from "./email-verify.js";

export async function getContactEmailVerification(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact || contact.site_id !== siteId) {
    const err = new Error("Contatto non trovato");
    err.status = 404;
    throw err;
  }

  const result = await verifySubscriberEmail(contact.email);
  return {
    email: contact.email,
    status: result.status,
    reason: result.reason,
  };
}
