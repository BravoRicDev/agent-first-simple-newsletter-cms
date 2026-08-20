import {
  listOpportunities as listBase,
  getOpportunity as getBase,
  createOpportunity as createBase,
  updateOpportunity as updateBase,
  deleteOpportunity as deleteBase,
} from "./opportunities.js";
import {
  getOpportunityCustomValues, setOpportunityCustomValues,
  mergeOpportunityCustomValues, clearOpportunityCustomValues,
} from "./opportunity-custom-values.js";

// ─────────────────────────────────────────────────────────────────────────
// RIFINITURA v1 — Opportunità con CUSTOM FIELDS (object_key='opportunity').
//
// Riusa il servizio condiviso `opportunities.js` (usato anche dalla surface
// admin legacy) e lo arricchisce con i valori dei custom field del tenant.
// I custom field per-tenant di un'opportunità vivono in
// `opportunity_custom_values` (JSONB { field_key: value }), validati contro
// `custom_fields` (object_key='opportunity'); field_key sconosciuti ignorati
// con warn. Vedi opportunity-custom-values.js.
//
// Ogni funzione ritorna il payload JSON della surface /v1 (via
// serializeOpportunity), che include `customFields: { field_key: value }`,
// come prescritto da ONDA1_SPEC.
//
// NON modifica le firme del servizio condiviso: qui si fa solo import + wrap.
// ─────────────────────────────────────────────────────────────────────────

// Mappa una riga del servizio condiviso → payload JSON /v1, aggiungendo i
// custom field. `customValues` = { field_key: value } da getOpportunityCustomValues.
export function serializeOpportunity(o, customValues = {}) {
  if (!o) return null;
  return {
    id: o.id,
    contactEmail: o.contact_email,
    pipelineId: o.pipeline_id,
    pipelineName: o.pipeline_name || null,
    stage: o.stage,
    title: o.title,
    amount: o.amount !== null && o.amount !== undefined ? Number(o.amount) : 0,
    probability: o.probability,
    status: o.status,
    expectedCloseDate: o.expected_close_at,
    notes: o.notes,
    customFields: { ...(customValues || {}) },
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

async function resolveCustomValues(siteId, opportunityId) {
  return getOpportunityCustomValues(siteId, opportunityId);
}

export async function getOpportunity(siteId, id) {
  const o = await getBase(siteId, id);
  if (!o) return null;
  return serializeOpportunity(o, await resolveCustomValues(siteId, o.id));
}

// Crea un'opportunità e (se presente) persiste i custom field per-tenant.
// `data` accetta le chiavi del servizio condiviso + `customFields{}`.
export async function createOpportunity(siteId, data = {}) {
  const o = await createBase(siteId, {
    email: data.email,
    pipeline_id: data.pipeline_id,
    stage: data.stage,
    title: data.title,
    amount: data.amount,
    probability: data.probability,
    expected_close_at: data.expected_close_at,
    notes: data.notes,
  });
  if (!o) return null;
  if (data.customFields && typeof data.customFields === "object") {
    await setOpportunityCustomValues(siteId, o.id, data.customFields);
  }
  return serializeOpportunity(o, await resolveCustomValues(siteId, o.id));
}

// Aggiorna un'opportunità e (se presente) fa merge dei custom field.
export async function updateOpportunity(siteId, id, data = {}) {
  const fields = { ...data };
  delete fields.customFields;
  const o = await updateBase(siteId, id, fields);
  if (!o) return null;
  if (data.customFields && typeof data.customFields === "object") {
    await mergeOpportunityCustomValues(siteId, o.id, data.customFields);
  }
  return serializeOpportunity(o, await resolveCustomValues(siteId, o.id));
}

// Lista opportunità con custom field nel payload.
export async function listOpportunities(siteId, filters = {}) {
  const rows = await listBase(siteId, filters);
  const out = [];
  for (const o of rows) out.push(serializeOpportunity(o, await resolveCustomValues(siteId, o.id)));
  return out;
}

// Upsert per (contact_email + title esatto). Ritorna { opportunity, created }.
export async function upsertOpportunity(siteId, input = {}) {
  const { contactEmail, contact_email, title, ...rest } = input;
  const email = contactEmail || contact_email;
  const data = { ...rest };
  // Normalizza alias camelCase delle surface → snake_case del servizio base.
  if (data.pipelineId !== undefined && data.pipeline_id === undefined) data.pipeline_id = data.pipelineId;
  if (data.expectedCloseDate !== undefined && data.expected_close_at === undefined) data.expected_close_at = data.expectedCloseDate;
  const list = await listOpportunities(siteId, { email });
  const match = list.find((o) => o.title === String(title).trim());
  if (match) {
    const opportunity = await updateOpportunity(siteId, match.id, data);
    return { opportunity, created: false };
  }
  const opportunity = await createOpportunity(siteId, { email, title, ...data });
  return { opportunity, created: !!opportunity };
}

export async function deleteOpportunity(siteId, id) {
  await clearOpportunityCustomValues(siteId, id);
  return deleteBase(siteId, id);
}
