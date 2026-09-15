import crypto from "crypto";
import { Router } from "express";
import express from "express";
import multer from "multer";
import { query } from "../db.js";
import { requireTenant } from "../middleware/tenant-api.js";
import { v1RateLimiter } from "../middleware/rate-limit-v1.js";
import { v1BodyValidator } from "../middleware/body-validate-v1.js";
import {
  listCustomFields, getCustomField, createCustomField,
  updateCustomField, deleteCustomField, listByObjectKey,
} from "../services/custom-fields.js";
import { listCapabilities } from "../services/capabilities.js";
import {
  getBoardPipelines, getBoard, moveOpportunityStage,
  listQuotes, getQuote, createQuote, updateQuote,
  setQuoteStatus, deleteQuote, buildQuotePdf,
} from "../services/opportunities.js";
import {
  listOpportunities, getOpportunity, createOpportunity,
  updateOpportunity, deleteOpportunity, upsertOpportunity,
} from "../services/opportunities-v1.js";
import { mergeContacts } from "../services/merge.js";
import {
  createContact, getContact, updateContact, deleteContact,
  listContacts, searchContacts, upsertContactByEmail, findDuplicateContacts,
  addContactNote, listContactNotes, deleteContactNote,
  listContactTags, addContactTags, removeContactTag, setContactTags,
} from "../services/contacts-v1.js";
import { listTasks, createTask, updateTask, deleteTask, getTask, getFunnel } from "../services/tasks.js";
import {
  listBookings, getBooking, createBooking,
  updateBooking, cancelBooking,
} from "../services/booking.js";
import { openapiRouter } from "../openapi.js";
import {
  listPaymentLinks, getPaymentLink, createPaymentLink,
  updatePaymentLink, deletePaymentLink, markPaid,
} from "../services/payments.js";
import { getKpis } from "../services/dashboard.js";
import {
  listConversations, getConversation, listConversationMessages,
  addConversationMessage, setConversationStatus, deleteConversation,
} from "../services/conversations.js";
import {
  getEmailStatsCampaign, getEmailStatsAggregate, listEmailStatsCampaigns,
  getEmailStatsSequence, listEmailStatsSequences,
} from "../services/newsletter-stats.js";
import { importCrmData, listImportJobs, getImportJob, importFromFile } from "../services/export-import.js";
import {
  listConfigs as listReportConfigs, getConfig as getReportConfig,
  createConfig as createReportConfig, updateConfig as updateReportConfig,
  deleteConfig as deleteReportConfig, generateReport, listRuns,
} from "../services/reports.js";
import {
  sanitizeSegmentRules, listSegmentMembers, recountSegment, previewSegment,
} from "../services/segments.js";
import { sanitizeWorkflow, testWorkflow } from "../services/workflows.js";
import {
  sanitizeScoringRule, sanitizeScoringThreshold,
} from "../services/scoring.js";

// ─────────────────────────────────────────────────────────────────────────
// Helper CSV (export ONDA 3). Genera un documento CSV testuale con header,
// valori escapati (quote raddoppiate) e separatore `,`. Le righe arrivano
// come array di oggetti; `columns` definisce l'ordine/la selezione
// ([{ key, label }]). Usato da /v1/activities e /v1/email-stats/*?format=csv.
// ─────────────────────────────────────────────────────────────────────────
function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows = [], columns = []) {
  if (!columns.length) return "";
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(","));
  return [header, ...body].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Surface API compatibile ("API compatibili con CRM diffusi"), montata su
// /v1. Tutte le route passano da requireTenant(): header Location-Id + Bearer
// API key del sito. Header `Version:` ignorato (vedi middleware/tenant-api.js).
//
// Convenzione risposte JSON "enveloping": { customFields, pipelines, config,
// capabilities, apiKeys } ecc. 401 tenant/API key non valida, 404 risorsa
// inesistente, 400 validazione.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// Documentazione OpenAPI pubblica (openapi.json + docs interattiva) montata
// PRIMA di requireTenant(): la documentazione è pubblica e non richiede
// Location-Id/Bearer.
router.use(openapiRouter);

// Tutte le route API sotto passano da requireTenant() (tenancy + auth Bearer,
// header Version ignorato). Montiamo PRIMA un parser text/csv per supportare
// /v1/import con body CSV grezzo (express.json non parsaa text/csv).
router.use(express.text({ type: ["text/csv"], limit: "5mb" }));
router.use(requireTenant());

// Rate limiting + body validation per tutta la surface /v1
router.use(v1RateLimiter());
router.use(v1BodyValidator());

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

// ── Custom fields ───────────────────────────────────────────────────────

router.get("/custom-fields", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const objectKey = req.query.objectKey ? String(req.query.objectKey) : null;
    const fields = await listCustomFields(siteId, { objectKey });
    res.json({ customFields: fields });
  } catch (err) { next(err); }
});

// Route statiche PRIMA di /:id (ordine delle route conta in Express).
router.get("/custom-fields/object-key/:objectKey", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const fields = await listByObjectKey(siteId, req.params.objectKey);
    res.json({ customFields: fields });
  } catch (err) { next(err); }
});

router.get("/custom-fields/folder", (req, res) => {
  // Cartella custom fields: per v1 rispondiamo con la struttura dei folder
  // raggruppata per object_key (compat). Nessuna tabella folder dedicata ora.
  res.json({ folders: [] });
});

router.get("/custom-fields/:id", async (req, res, next) => {
  try {
    const field = await getCustomField(req.tenant.siteId, req.params.id);
    if (!field) return res.status(404).json({ error: "Custom field non trovato" });
    res.json({ customField: field });
  } catch (err) { next(err); }
});

router.post("/custom-fields", async (req, res, next) => {
  try {
    const field = await createCustomField(req.tenant.siteId, req.body || {});
    if (!field) return res.status(400).json({ error: "Dati custom field non validi" });
    res.status(201).json({ customField: field });
  } catch (err) { next(err); }
});

router.put("/custom-fields/:id", async (req, res, next) => {
  try {
    const field = await updateCustomField(req.tenant.siteId, req.params.id, req.body || {});
    if (!field) return res.status(404).json({ error: "Custom field non trovato" });
    res.json({ customField: field });
  } catch (err) { next(err); }
});

router.delete("/custom-fields/:id", async (req, res, next) => {
  try {
    const deletedId = await deleteCustomField(req.tenant.siteId, req.params.id);
    if (!deletedId) return res.status(404).json({ error: "Custom field non trovato" });
    res.json({ deleted: true, id: deletedId });
  } catch (err) { next(err); }
});

// ── Pipelines / stages ──────────────────────────────────────────────────

// pipeline_stage_priorities: invieremo un payload { name, stages: [...] }.
// La pipeline viene creata in `pipelines` con stages JSONB e gli stadi anche
// in `pipeline_stages` (id stabili per-stadio).
function normalizeStages(stages) {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s, i) => ({
      key: String(s?.key || s?.id || `stage_${i + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 100),
      label: String(s?.label || s?.name || s?.key || `Stage ${i + 1}`).slice(0, 255),
      color: String(s?.color || "").slice(0, 30),
      position: i,
    }))
    .filter((s) => s.key);
}

router.get("/pipelines", async (req, res, next) => {
  try {
    const pipelines = await getBoardPipelines(req.tenant.siteId);
    res.json({ pipelines });
  } catch (err) { next(err); }
});

router.post("/pipelines", async (req, res, next) => {
  const client = null;
  try {
    const { siteId } = req.tenant;
    const name = String((req.body || {}).name || "").trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: "nome pipeline obbligatorio" });
    const stages = normalizeStages((req.body || {}).stages);
    const isDefault = (req.body || {}).is_default === true || (req.body || {}).isDefault === true;

    const pipeline = (await query(
      `INSERT INTO pipelines (site_id, name, stages, is_default)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [siteId, name, JSON.stringify(stages), isDefault]
    )).rows[0];

    // Persisti anche gli stadi in pipeline_stages (id stabili).
    for (const s of stages) {
      await query(
        `INSERT INTO pipeline_stages (pipeline_id, key, label, color, position)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (pipeline_id, key) DO UPDATE SET
           label = EXCLUDED.label, color = EXCLUDED.color, position = EXCLUDED.position, updated_at = NOW()`,
        [pipeline.id, s.key, s.label, s.color, s.position]
      );
    }

    res.status(201).json({ pipeline: { id: pipeline.id, name: pipeline.name, is_default: pipeline.is_default, stages } });
  } catch (err) {
    // 23505 = unique violation (site_id, name)
    if (err.code === "23505") return res.status(400).json({ error: "Nome pipeline già esistente per il tenant" });
    next(err);
  }
});

router.get("/pipelines/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const p = (await query(
      "SELECT id, name, stages, is_default FROM pipelines WHERE id = $1 AND site_id = $2",
      [id, siteId]
    )).rows[0];
    if (!p) return res.status(404).json({ error: "Pipeline non trovata" });
    let stages = [];
    try { stages = typeof p.stages === "string" ? JSON.parse(p.stages) : (Array.isArray(p.stages) ? p.stages : []); } catch { stages = []; }
    res.json({ pipeline: { id: p.id, name: p.name, is_default: p.is_default, stages } });
  } catch (err) { next(err); }
});

router.put("/pipelines/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    const current = (await query("SELECT * FROM pipelines WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!current) return res.status(404).json({ error: "Pipeline non trovata" });

    const name = body.name !== undefined ? String(body.name).trim().slice(0, 255) : current.name;
    const stages = body.stages !== undefined ? normalizeStages(body.stages) : (() => {
      try { return typeof current.stages === "string" ? JSON.parse(current.stages) : (Array.isArray(current.stages) ? current.stages : []); } catch { return []; }
    })();
    const isDefault = body.is_default !== undefined ? (body.is_default === true) : current.is_default;

    await query(
      "UPDATE pipelines SET name = $1, stages = $2, is_default = $3 WHERE id = $4 AND site_id = $5",
      [name, JSON.stringify(stages), isDefault, id, siteId]
    );

    // Sincronizza pipeline_stages.
    const existing = (await query("SELECT id FROM pipeline_stages WHERE pipeline_id = $1", [id])).rows;
    const existingIds = new Set(existing.map((r) => r.id));
    for (const s of stages) {
      const row = (await query(
        `INSERT INTO pipeline_stages (pipeline_id, key, label, color, position)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (pipeline_id, key) DO UPDATE SET
           label = EXCLUDED.label, color = EXCLUDED.color, position = EXCLUDED.position, updated_at = NOW()
         RETURNING id`,
        [id, s.key, s.label, s.color, s.position]
      )).rows[0];
      if (row) existingIds.delete(row.id);
    }
    // Rimuovi stadi non più presenti (per id, non per key).
    if (existingIds.size > 0) {
      await query("DELETE FROM pipeline_stages WHERE pipeline_id = $1 AND id = ANY($2::int[])", [id, [...existingIds]]);
    }

    res.json({ pipeline: { id, name, is_default: isDefault, stages } });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Nome pipeline già esistente per il tenant" });
    next(err);
  }
});

router.delete("/pipelines/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const deleted = await query("DELETE FROM pipelines WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (deleted.rowCount === 0) return res.status(404).json({ error: "Pipeline non trovata" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

// ── Config per-tenant ───────────────────────────────────────────────────

router.get("/config", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const rows = (await query("SELECT key, value FROM tenant_config WHERE site_id = $1", [siteId])).rows;
    const config = {};
    // value è JSONB: pg lo ritorna già parsato (oggetto/array/scalare).
    for (const r of rows) config[r.key] = r.value;
    res.json({ config });
  } catch (err) { next(err); }
});

router.put("/config", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const body = (req.body || {}).config || req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "config deve essere un oggetto chiave/valore" });
    }
    for (const [key, value] of Object.entries(body)) {
      if (!key) continue;
      const k = String(key).slice(0, 100);
      await query(
        `INSERT INTO tenant_config (site_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [siteId, k, JSON.stringify(value ?? {})]
      );
    }
    const rows = (await query("SELECT key, value FROM tenant_config WHERE site_id = $1", [siteId])).rows;
    const config = {};
    for (const r of rows) config[r.key] = r.value;
    res.json({ config });
  } catch (err) { next(err); }
});

// ── Mapping Location ↔ Site (gestione + esposizione verso n8n) ──────────
//
// Con questo endpoint il consumer (es. un nodo n8n) può leggere l'identificativo
// esterno della location associato al tenant autenticato, e aggiornarlo/cancellarlo.
// Il valore è quello che, passato nell'header `Location-Id`, identifica il site
// giusto (oltre a id numerico e domain).

router.get("/location", async (req, res, next) => {
  try {
    const row = (await query("SELECT location_external_id FROM sites WHERE id = $1", [req.tenant.siteId])).rows[0];
    res.json({ location: { siteId: req.tenant.siteId, externalId: row?.location_external_id ?? null } });
  } catch (err) { next(err); }
});

router.put("/location", async (req, res, next) => {
  try {
    const body = req.body || {};
    // Accetta sia { externalId } sia { locationId } per comodità di compatibilità.
    const raw = body.externalId ?? body.locationId ?? null;
    if (raw === null || raw === "") {
      return res.status(400).json({ error: "externalId (o locationId) obbligatorio nel body" });
    }
    const externalId = String(raw).trim().slice(0, 255);
    if (!externalId) return res.status(400).json({ error: "externalId non valido" });

    await query("UPDATE sites SET location_external_id = $1 WHERE id = $2", [externalId, req.tenant.siteId]);
    res.json({ location: { siteId: req.tenant.siteId, externalId } });
  } catch (err) {
    // 23505 = unique violation su location_external_id (mapping già usato da altro site).
    if (err.code === "23505") return res.status(409).json({ error: "Identificativo location già associato a un altro tenant" });
    next(err);
  }
});

router.delete("/location", async (req, res, next) => {
  try {
    await query("UPDATE sites SET location_external_id = NULL WHERE id = $1", [req.tenant.siteId]);
    res.json({ location: { siteId: req.tenant.siteId, externalId: null } });
  } catch (err) { next(err); }
});

// ── Capability registry ─────────────────────────────────────────────────

router.get("/capabilities", async (req, res, next) => {
  try {
    const capabilities = await listCapabilities();
    res.json({ capabilities });
  } catch (err) { next(err); }
});

// ── Opportunità (compat): motivi perdita + alias pipelines ─────────────

router.get("/opportunities/lost-reason", (req, res) => {
  res.json({ lostReasons: ["prezzo", "concorrenza", "timing", "budget", "altre"] });
});

router.get("/opportunities/pipelines", async (req, res, next) => {
  try {
    const pipelines = await getBoardPipelines(req.tenant.siteId);
    res.json({ pipelines });
  } catch (err) { next(err); }
});

// ── API key per-sito ────────────────────────────────────────────────────

const TOKEN_PREFIX = "sitekey_";

router.post("/api-keys", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const name = String((req.body || {}).name || "").trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: "nome API key obbligatorio" });

    const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
    const prefix = raw.slice(0, 16);

    const row = (await query(
      `INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active)
       VALUES ($1, $2, $3, $4, true) RETURNING id, created_at`,
      [siteId, name, sha256(raw), prefix]
    )).rows[0];

    // Il token in chiaro esiste SOLO qui, una volta.
    res.status(201).json({
      apiKey: {
        id: row.id, name, prefix, active: true, created_at: row.created_at,
        token: raw,
      },
    });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Nome API key già esistente per il tenant" });
    next(err);
  }
});

router.get("/api-keys", async (req, res, next) => {
  try {
    const rows = (await query(
      "SELECT id, name, token_prefix, active, last_used_at, created_at FROM site_api_keys WHERE site_id = $1 ORDER BY created_at DESC",
      [req.tenant.siteId]
    )).rows;
    res.json({ apiKeys: rows });
  } catch (err) { next(err); }
});

router.delete("/api-keys/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const r = await query("DELETE FROM site_api_keys WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (r.rowCount === 0) return res.status(404).json({ error: "API key non trovata" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// ONDA 1 — Core CRM: contatti (CRUD + search + upsert + duplicate + note +
// tags + tasks + followers + campaigns + workflow).
// Route statiche PRIMA di /:id (ordine Express).
// ─────────────────────────────────────────────────────────────────────────

router.get("/contacts", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const { limit, offset, query: q, tag, status } = req.query;
    const { contacts, total } = await listContacts(siteId, { limit, offset, query: q, tag, status });
    res.json({ contacts, total });
  } catch (err) { next(err); }
});

router.post("/contacts", async (req, res, next) => {
  try {
    const result = await createContact(req.tenant.siteId, req.body || {});
    if (!result || !result.contact) {
      if (result?.duplicateId) return res.status(409).json({ error: "Contatto già esistente", id: result.duplicateId });
      return res.status(400).json({ error: "Dati contatto non validi (email obbligatoria)" });
    }
    res.status(201).json({ contact: result.contact });
  } catch (err) { next(err); }
});

router.post("/contacts/search", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const body = req.body || {};
    const { contacts, total } = await searchContacts(siteId, {
      query: body.query, tag: body.tag || body.filters?.tag,
    });
    res.json({ contacts, total });
  } catch (err) { next(err); }
});

router.post("/contacts/upsert", async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.email) return res.status(400).json({ error: "email obbligatoria per upsert" });
    const { contact, created } = await upsertContactByEmail(req.tenant.siteId, body.email, body);
    if (!contact) return res.status(400).json({ error: "Dati contatto non validi" });
    res.status(created ? 201 : 200).json({ contact, created });
  } catch (err) { next(err); }
});

router.post("/contacts/search/duplicate", async (req, res, next) => {
  try {
    const body = req.body || {};
    const duplicates = await findDuplicateContacts(req.tenant.siteId, {
      email: body.email, name: body.name, phone: body.phone,
    });
    res.json({ duplicates });
  } catch (err) { next(err); }
});

// ── Contatti: merge ────────────────────────────────────────────────────────
router.post("/contacts/merge", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const result = await mergeContacts(siteId, b.sourceEmail || b.source_email, b.intoEmail || b.into_email);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/contacts/:id", async (req, res, next) => {
  try {
    const contact = await getContact(req.tenant.siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ contact });
  } catch (err) { next(err); }
});

router.put("/contacts/:id", async (req, res, next) => {
  try {
    const contact = await updateContact(req.tenant.siteId, req.params.id, req.body || {});
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ contact });
  } catch (err) { next(err); }
});

router.delete("/contacts/:id", async (req, res, next) => {
  try {
    const id = await deleteContact(req.tenant.siteId, req.params.id);
    if (!id) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

// ── Contatti: note ───────────────────────────────────────────────────────

router.post("/contacts/:id/notes", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const body = String((req.body || {}).body || "").trim();
    if (!body) return res.status(400).json({ error: "body nota obbligatorio" });
    const note = await addContactNote(siteId, req.params.id, body);
    if (!note) return res.status(404).json({ error: "Contatto non trovato" });
    res.status(201).json({ note });
  } catch (err) { next(err); }
});

router.get("/contacts/:id/notes", async (req, res, next) => {
  try {
    const notes = await listContactNotes(req.tenant.siteId, req.params.id);
    if (notes === null) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ notes });
  } catch (err) { next(err); }
});

router.delete("/contacts/:id/notes/:noteId", async (req, res, next) => {
  try {
    const id = await deleteContactNote(req.tenant.siteId, req.params.noteId);
    if (!id) return res.status(404).json({ error: "Nota non trovata" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

// ── Contatti: tags ───────────────────────────────────────────────────────

router.get("/contacts/:id/tags", async (req, res, next) => {
  try {
    const tags = await listContactTags(req.tenant.siteId, req.params.id);
    if (tags === null) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ tags });
  } catch (err) { next(err); }
});

router.post("/contacts/:id/tags", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const body = req.body || {};
    const tags = await addContactTags(siteId, req.params.id, body.tags ?? body.tag);
    if (tags === null) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ tags });
  } catch (err) { next(err); }
});

router.delete("/contacts/:id/tags/:tag", async (req, res, next) => {
  try {
    const tags = await removeContactTag(req.tenant.siteId, req.params.id, req.params.tag);
    if (tags === null) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ tags });
  } catch (err) { next(err); }
});

router.put("/contacts/:id/tags", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const body = req.body || {};
    const tags = await setContactTags(siteId, req.params.id, body.tags ?? body.tag);
    if (tags === null) return res.status(404).json({ error: "Contatto non trovato" });
    res.json({ tags });
  } catch (err) { next(err); }
});

// ── Contatti: tasks ──────────────────────────────────────────────────────

router.get("/contacts/:id/tasks", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const contact = await getContact(siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const tasks = await listTasks(siteId, { email: contact.email });
    res.json({ tasks });
  } catch (err) { next(err); }
});

router.post("/contacts/:id/tasks", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const contact = await getContact(siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: "title obbligatorio" });
    const task = await createTask(siteId, {
      title: body.title, email: contact.email, notes: body.notes,
      dueAt: body.dueAt || body.due_at || null,
      assigneeId: body.assigneeId || body.assignee_id || null,
    });
    res.status(201).json({ task });
  } catch (err) { next(err); }
});

router.put("/contacts/:id/tasks/:taskId", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const contact = await getContact(siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const body = req.body || {};
    const task = await updateTask(siteId, req.params.taskId, {
      title: body.title, notes: body.notes, status: body.status,
      dueAt: body.dueAt || body.due_at, assigneeId: body.assigneeId || body.assignee_id,
    });
    if (!task) return res.status(404).json({ error: "Task non trovata" });
    res.json({ task });
  } catch (err) { next(err); }
});

router.delete("/contacts/:id/tasks/:taskId", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const contact = await getContact(siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const task = await getTask(siteId, req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task non trovata" });
    await deleteTask(siteId, req.params.taskId);
    res.json({ deleted: true, id: parseInt(req.params.taskId, 10) });
  } catch (err) { next(err); }
});

// ── Contatti: followers / campaigns / workflow (v1: strutture minime) ────

router.get("/contacts/:id/followers", async (req, res, next) => {
  try {
    const contact = await getContact(req.tenant.siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const rows = (await query(
      `SELECT u.id, u.email, u.name FROM contact_followers f
       JOIN users u ON u.id = f.user_id
       WHERE f.site_id = $1 AND f.contact_id = $2 ORDER BY f.created_at DESC`,
      [req.tenant.siteId, contact.id]
    )).rows;
    res.json({ followers: rows });
  } catch (err) { next(err); }
});

router.post("/contacts/:id/followers", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const contact = await getContact(siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const userId = parseInt((req.body || {}).userId || (req.body || {}).user_id, 10);
    if (!userId) return res.status(400).json({ error: "userId obbligatorio" });
    await query(
      `INSERT INTO contact_followers (site_id, contact_id, user_id)
       VALUES ($1, $2, $3) ON CONFLICT (site_id, contact_id, user_id) DO NOTHING`,
      [siteId, contact.id, userId]
    );
    const rows = (await query(
      `SELECT u.id, u.email, u.name FROM contact_followers f
       JOIN users u ON u.id = f.user_id WHERE f.site_id = $1 AND f.contact_id = $2`,
      [siteId, contact.id]
    )).rows;
    res.status(201).json({ followers: rows });
  } catch (err) {
    // 23505/23503 → user non valido
    if (err.code === "23503") return res.status(400).json({ error: "user non valido" });
    next(err);
  }
});

router.get("/contacts/:id/campaigns", async (req, res, next) => {
  try {
    const contact = await getContact(req.tenant.siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    // v1: nessun link diretto campagna↔contatto materializzato → lista vuota
    // (struttura pronta per le onde successive).
    res.json({ campaigns: [] });
  } catch (err) { next(err); }
});

router.get("/contacts/:id/workflow", async (req, res, next) => {
  try {
    const contact = await getContact(req.tenant.siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const events = (await query(
      `SELECT event_type, payload, created_at FROM contact_events
       WHERE site_id = $1 AND email = $2 ORDER BY created_at DESC LIMIT 25`,
      [req.tenant.siteId, contact.email]
    )).rows;
    res.json({ workflow: { contact_id: contact.id, email: contact.email, events } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// ONDA 1 — Opportunità (riusa services/opportunities-v1.js, che aggiunge i
// custom field al payload via serializeOpportunity).
// ─────────────────────────────────────────────────────────────────────────

router.get("/opportunities", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const { status, stage, contactEmail } = req.query;
    const opportunities = await listOpportunities(siteId, { status, stage, email: contactEmail });
    res.json({ opportunities, total: opportunities.length });
  } catch (err) { next(err); }
});

router.post("/opportunities", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const opp = await createOpportunity(siteId, {
      email: b.contactEmail || b.contact_email,
      pipeline_id: b.pipelineId || b.pipeline_id || null,
      stage: b.stage,
      title: b.title,
      amount: b.amount,
      probability: b.probability,
      expected_close_at: b.expectedCloseDate || b.expected_close_at || null,
      notes: b.notes,
      customFields: b.customFields,
    });
    if (!opp) return res.status(400).json({ error: "Dati opportunità non validi (contactEmail + title obbligatori)" });
    res.status(201).json({ opportunity: opp });
  } catch (err) { next(err); }
});

router.post("/opportunities/search", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const opportunities = await listOpportunities(siteId, {
      status: b.status || b.filters?.status, stage: b.stage || b.filters?.stage,
      email: b.contactEmail || b.filters?.contactEmail,
    });
    res.json({ opportunities, total: opportunities.length });
  } catch (err) { next(err); }
});

router.post("/opportunities/upsert", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    if (!b.contactEmail || !b.title) return res.status(400).json({ error: "contactEmail + title obbligatori per upsert" });
    const { opportunity, created } = await upsertOpportunity(siteId, b);
    if (!opportunity) return res.status(400).json({ error: "Dati opportunità non validi" });
    res.status(created ? 201 : 200).json({ opportunity, created });
  } catch (err) { next(err); }
});

// ── Kanban board — PRIMA delle route parametriche ──────────────────────
router.get("/opportunities/board", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const { pipelineId } = req.query;
    const result = await getBoard(siteId, { pipelineId });
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/opportunities/:id", async (req, res, next) => {
  try {
    const opp = await getOpportunity(req.tenant.siteId, req.params.id);
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ opportunity: opp });
  } catch (err) { next(err); }
});

router.put("/opportunities/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const fields = {};
    if (b.title !== undefined) fields.title = b.title;
    if (b.stage !== undefined) fields.stage = b.stage;
    if (b.status !== undefined) fields.status = b.status;
    if (b.amount !== undefined) fields.amount = b.amount;
    if (b.probability !== undefined) fields.probability = b.probability;
    if (b.pipelineId !== undefined || b.pipeline_id !== undefined) fields.pipeline_id = b.pipelineId ?? b.pipeline_id;
    if (b.expectedCloseDate !== undefined) fields.expected_close_at = b.expectedCloseDate;
    if (b.expected_close_at !== undefined) fields.expected_close_at = b.expected_close_at;
    if (b.notes !== undefined) fields.notes = b.notes;
    if (b.customFields !== undefined) fields.customFields = b.customFields;
    const opp = await updateOpportunity(siteId, req.params.id, fields);
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ opportunity: opp });
  } catch (err) { next(err); }
});

router.delete("/opportunities/:id", async (req, res, next) => {
  try {
    const n = await deleteOpportunity(req.tenant.siteId, req.params.id);
    if (!n) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ deleted: true, id: parseInt(req.params.id, 10) });
  } catch (err) { next(err); }
});

router.put("/opportunities/:id/status", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    if (!["open", "won", "lost"].includes(b.status)) return res.status(400).json({ error: "status deve essere open|won|lost" });
    const opp = await getOpportunity(siteId, req.params.id);
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    // updateOpportunity emette opportunity_status_changed → webhook out.
    const updated = await updateOpportunity(siteId, opp.id, { status: b.status });
    res.json({ opportunity: updated });
  } catch (err) { next(err); }
});

router.get("/opportunities/:id/followers", async (req, res, next) => {
  try {
    const opp = await getOpportunity(req.tenant.siteId, req.params.id);
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ followers: [] });
  } catch (err) { next(err); }
});

// ── Opportunità: sposta stage (kanban drag&drop) ────────────────────────
router.put("/opportunities/:id/move", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const opp = await moveOpportunityStage(siteId, req.params.id, {
      stage: b.stage, pipeline_id: b.pipelineId || b.pipeline_id,
    });
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ opportunity: opp });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// Quote / Preventivi (PDF generato al volo con pdfkit)
// ─────────────────────────────────────────────────────────────────────────

router.get("/quotes", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const { status, contactEmail, opportunityId } = req.query;
    const quotes = await listQuotes(siteId, { status, email: contactEmail, opportunity_id: opportunityId });
    res.json({ quotes, total: quotes.length });
  } catch (err) { next(err); }
});

router.post("/quotes", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const quote = await createQuote(siteId, {
      opportunity_id: b.opportunityId || b.opportunity_id || null,
      contact_email: b.contactEmail || b.contact_email,
      title: b.title,
      items: b.items,
      notes: b.notes,
    });
    if (!quote) return res.status(400).json({ error: "Dati preventivo non validi (contactEmail obbligatorio)" });
    res.status(201).json({ quote });
  } catch (err) { next(err); }
});

router.get("/quotes/:id", async (req, res, next) => {
  try {
    const quote = await getQuote(req.tenant.siteId, req.params.id);
    if (!quote) return res.status(404).json({ error: "Preventivo non trovato" });
    res.json({ quote });
  } catch (err) { next(err); }
});

router.put("/quotes/:id", async (req, res, next) => {
  try {
    const b = req.body || {};
    const quote = await updateQuote(req.tenant.siteId, req.params.id, {
      title: b.title, items: b.items, notes: b.notes, status: b.status,
    });
    if (!quote) return res.status(404).json({ error: "Preventivo non trovato" });
    res.json({ quote });
  } catch (err) { next(err); }
});

router.put("/quotes/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!["draft", "sent", "viewed", "signed"].includes(status)) {
      return res.status(400).json({ error: "status deve essere draft|sent|viewed|signed" });
    }
    const quote = await setQuoteStatus(req.tenant.siteId, req.params.id, status);
    if (!quote) return res.status(404).json({ error: "Preventivo non trovato" });
    res.json({ quote });
  } catch (err) { next(err); }
});

router.delete("/quotes/:id", async (req, res, next) => {
  try {
    const n = await deleteQuote(req.tenant.siteId, req.params.id);
    if (!n) return res.status(404).json({ error: "Preventivo non trovato" });
    res.json({ deleted: true, id: parseInt(req.params.id, 10) });
  } catch (err) { next(err); }
});

router.get("/quotes/:id/pdf", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const quote = await getQuote(siteId, req.params.id);
    if (!quote) return res.status(404).json({ error: "Preventivo non trovato" });
    const siteRow = (await query("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0];
    const doc = buildQuotePdf(quote, siteRow?.name || "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="preventivo-${quote.quote_number}.pdf"`);
    // Stream error handler: EPIPE/disconnessione non deve crashare il processo.
    doc.on("error", (err) => {
      if (!res.headersSent) next(err); else res.destroy();
    });
    res.on("error", () => { try { doc.destroy(); } catch { /* già chiuso */ } });
    doc.pipe(res);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// CRM agent features su /v1: Segmenti, Workflow, Scoring
// Route statiche PRIMA delle parametriche (/segments/preview prima di /:id)
// ─────────────────────────────────────────────────────────────────────────

// ── Segmenti ──────────────────────────────────────────────────────────
// Route statica preview PRIMA di /:id

router.get("/segments", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const segments = (await query(
      `SELECT s.*, COUNT(m.email)::int AS members
       FROM segments s LEFT JOIN segment_members m ON m.segment_id = s.id
       WHERE s.site_id = $1 GROUP BY s.id ORDER BY s.name`,
      [siteId]
    )).rows;
    res.json({ segments });
  } catch (err) { next(err); }
});

router.post("/segments", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const name = String((req.body || {}).name || "").trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: "Nome segmento obbligatorio" });
    const rules = sanitizeSegmentRules(req.body.rules);
    const matchMode = req.body.match_mode === "any" ? "any" : "all";
    const description = String(req.body.description || "").slice(0, 2000);
    const enabled = req.body.enabled !== false;
    try {
      const result = await query(
        `INSERT INTO segments (site_id, name, description, rules, match_mode, enabled)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [siteId, name, description, JSON.stringify(rules), matchMode, enabled]
      );
      res.status(201).json({ segment: result.rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Segmento con questo nome già esistente" });
      throw err;
    }
  } catch (err) { next(err); }
});

router.get("/segments/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const segment = (await query(
      `SELECT s.*, COUNT(m.email)::int AS members
       FROM segments s LEFT JOIN segment_members m ON m.segment_id = s.id
       WHERE s.id = $1 AND s.site_id = $2 GROUP BY s.id`,
      [id, siteId]
    )).rows[0];
    if (!segment) return res.status(404).json({ error: "Segmento non trovato" });
    res.json({ segment });
  } catch (err) { next(err); }
});

router.put("/segments/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const current = (await query("SELECT * FROM segments WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!current) return res.status(404).json({ error: "Segmento non trovato" });
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 255) : current.name;
    const rules = b.rules !== undefined ? sanitizeSegmentRules(b.rules) : current.rules;
    const matchMode = b.match_mode !== undefined ? (b.match_mode === "any" ? "any" : "all") : current.match_mode;
    const description = b.description !== undefined ? String(b.description).slice(0, 2000) : current.description;
    const enabled = b.enabled !== undefined ? !!b.enabled : current.enabled;
    if (!name) return res.status(400).json({ error: "Nome obbligatorio" });
    try {
      await query(
        `UPDATE segments SET name = $1, description = $2, rules = $3, match_mode = $4, enabled = $5, updated_at = NOW()
         WHERE id = $6 AND site_id = $7`,
        [name, description, JSON.stringify(rules), matchMode, enabled, id, siteId]
      );
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Segmento con questo nome già esistente" });
      throw err;
    }
    const row = (await query("SELECT * FROM segments WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    res.json({ segment: row });
  } catch (err) { next(err); }
});

router.delete("/segments/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const result = await query("DELETE FROM segments WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Segmento non trovato" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

router.get("/segments/:id/members", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const segment = (await query("SELECT id FROM segments WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!segment) return res.status(404).json({ error: "Segmento non trovato" });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = await listSegmentMembers(siteId, id, { limit, offset });
    res.json(result);
  } catch (err) { next(err); }
});

router.post("/segments/:id/recount", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const segment = (await query("SELECT id FROM segments WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!segment) return res.status(404).json({ error: "Segmento non trovato" });
    const result = await recountSegment(siteId, id);
    res.json(result);
  } catch (err) { next(err); }
});

router.post("/segments/preview", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const rules = sanitizeSegmentRules(b.rules);
    const matchMode = b.match_mode === "any" ? "any" : "all";
    const result = await previewSegment(siteId, rules, matchMode);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Workflow ──────────────────────────────────────────────────────────

router.get("/workflows", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const workflows = (await query(
      `SELECT w.*, COUNT(a.id)::int AS action_count
       FROM workflows w LEFT JOIN workflow_actions a ON a.workflow_id = w.id
       WHERE w.site_id = $1 GROUP BY w.id ORDER BY w.name`,
      [siteId]
    )).rows;
    res.json({ workflows });
  } catch (err) { next(err); }
});

router.post("/workflows", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const clean = sanitizeWorkflow(req.body);
    if (!clean || !clean.name) return res.status(400).json({ error: "Nome e trigger_type obbligatori" });
    const wfResult = await query(
      `INSERT INTO workflows (site_id, name, active, trigger_type, trigger_config)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [siteId, clean.name, clean.active, clean.trigger_type, JSON.stringify(clean.trigger_config)]
    );
    const workflow = wfResult.rows[0];
    const actions = [];
    for (const action of clean.actions) {
      const aResult = await query(
        `INSERT INTO workflow_actions (workflow_id, action_order, action_type, action_config)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [workflow.id, action.action_order, action.action_type, JSON.stringify(action.action_config)]
      );
      actions.push(aResult.rows[0]);
    }
    res.status(201).json({ workflow: { ...workflow, actions } });
  } catch (err) { next(err); }
});

router.get("/workflows/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const workflow = (await query("SELECT * FROM workflows WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!workflow) return res.status(404).json({ error: "Workflow non trovato" });
    const actions = (await query(
      "SELECT * FROM workflow_actions WHERE workflow_id = $1 ORDER BY action_order",
      [id]
    )).rows;
    res.json({ workflow: { ...workflow, actions } });
  } catch (err) { next(err); }
});

router.put("/workflows/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const current = (await query("SELECT * FROM workflows WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!current) return res.status(404).json({ error: "Workflow non trovato" });
    const clean = sanitizeWorkflow({ ...b, name: b.name ?? current.name, trigger_type: b.trigger_type ?? current.trigger_type });
    if (!clean) return res.status(400).json({ error: "trigger_type non valido" });
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 255) : current.name;
    const active = b.active !== undefined ? !!b.active : current.active;
    const triggerConfig = b.trigger_config !== undefined ? b.trigger_config : current.trigger_config;
    await query(
      `UPDATE workflows SET name = $1, active = $2, trigger_config = $3, trigger_type = $4, updated_at = NOW()
       WHERE id = $5 AND site_id = $6`,
      [name, active, JSON.stringify(triggerConfig), clean.trigger_type, id, siteId]
    );
    if (b.actions !== undefined) {
      await query("DELETE FROM workflow_actions WHERE workflow_id = $1", [id]);
      for (const action of clean.actions) {
        await query(
          `INSERT INTO workflow_actions (workflow_id, action_order, action_type, action_config)
           VALUES ($1, $2, $3, $4)`,
          [id, action.action_order, action.action_type, JSON.stringify(action.action_config)]
        );
      }
    }
    const row = (await query("SELECT * FROM workflows WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    const actions = (await query(
      "SELECT * FROM workflow_actions WHERE workflow_id = $1 ORDER BY action_order", [id]
    )).rows;
    res.json({ workflow: { ...row, actions } });
  } catch (err) { next(err); }
});

router.delete("/workflows/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const result = await query("DELETE FROM workflows WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Workflow non trovato" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

router.get("/workflows/:id/runs", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const workflow = (await query("SELECT id FROM workflows WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!workflow) return res.status(404).json({ error: "Workflow non trovato" });
    const runs = (await query(
      `SELECT id, email, trigger_type, status, error, created_at FROM workflow_runs
       WHERE workflow_id = $1 AND site_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [id, siteId, limit]
    )).rows;
    res.json({ runs });
  } catch (err) { next(err); }
});

router.post("/workflows/:id/test", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email non valida" });
    const workflow = (await query("SELECT id FROM workflows WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!workflow) return res.status(404).json({ error: "Workflow non trovato" });
    const result = await testWorkflow(siteId, id, email);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Scoring ───────────────────────────────────────────────────────────

router.get("/scoring-rules", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const rules = (await query("SELECT * FROM scoring_rules WHERE site_id = $1 ORDER BY points DESC", [siteId])).rows;
    res.json({ rules });
  } catch (err) { next(err); }
});

router.post("/scoring-rules", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const clean = sanitizeScoringRule(req.body);
    if (!clean || !clean.name) return res.status(400).json({ error: "Nome e event_type obbligatori" });
    const result = await query(
      `INSERT INTO scoring_rules (site_id, name, event_type, event_filter, points, enabled)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [siteId, clean.name, clean.event_type, JSON.stringify(clean.event_filter), clean.points, clean.enabled]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) { next(err); }
});

router.get("/scoring-rules/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const rule = (await query("SELECT * FROM scoring_rules WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!rule) return res.status(404).json({ error: "Regola di scoring non trovata" });
    res.json({ rule });
  } catch (err) { next(err); }
});

router.put("/scoring-rules/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const current = (await query("SELECT * FROM scoring_rules WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    if (!current) return res.status(404).json({ error: "Regola di scoring non trovata" });
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 255) : current.name;
    const points = b.points !== undefined ? (Number.isFinite(Number(b.points)) ? Number(b.points) : current.points) : current.points;
    const enabled = b.enabled !== undefined ? !!b.enabled : current.enabled;
    const eventFilter = b.event_filter !== undefined ? b.event_filter : current.event_filter;
    await query(
      `UPDATE scoring_rules SET name = $1, points = $2, enabled = $3, event_filter = $4 WHERE id = $5 AND site_id = $6`,
      [name, points, enabled, JSON.stringify(eventFilter), id, siteId]
    );
    const row = (await query("SELECT * FROM scoring_rules WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
    res.json({ rule: row });
  } catch (err) { next(err); }
});

router.delete("/scoring-rules/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const result = await query("DELETE FROM scoring_rules WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Regola di scoring non trovata" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

router.get("/scoring-thresholds", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const thresholds = (await query("SELECT * FROM scoring_thresholds WHERE site_id = $1 ORDER BY min_score", [siteId])).rows;
    res.json({ thresholds });
  } catch (err) { next(err); }
});

router.post("/scoring-thresholds", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const clean = sanitizeScoringThreshold(req.body);
    if (!clean) return res.status(400).json({ error: "min_score obbligatorio" });
    try {
      const result = await query(
        `INSERT INTO scoring_thresholds (site_id, min_score, action_type, action_config, enabled)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [siteId, clean.min_score, clean.action_type, JSON.stringify(clean.action_config), clean.enabled]
      );
      res.status(201).json({ threshold: result.rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Soglia per questo min_score già esistente" });
      throw err;
    }
  } catch (err) { next(err); }
});

router.delete("/scoring-thresholds/:id", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const id = parseInt(req.params.id, 10);
    const result = await query("DELETE FROM scoring_thresholds WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Soglia di scoring non trovata" });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

// ── Booking (ONDA 2) ──────────────────────────────────────────────────

router.post("/bookings", async (req, res, next) => {
  try {
    const booking = await createBooking(req.tenant.siteId, req.body);
    res.status(201).json({ booking });
  } catch (err) { next(err); }
});

router.get("/bookings", async (req, res, next) => {
  try {
    const { q } = req.query || {};
    const result = await listBookings(req.tenant.siteId, {
      status: q?.status,
      contactEmail: q?.contactEmail,
      limit: q?.limit,
      offset: q?.offset,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/bookings/:id", async (req, res, next) => {
  try {
    const booking = await getBooking(req.tenant.siteId, req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking non trovato" });
    res.json({ booking });
  } catch (err) { next(err); }
});

router.put("/bookings/:id", async (req, res, next) => {
  try {
    const booking = await updateBooking(req.tenant.siteId, req.params.id, req.body);
    if (!booking) return res.status(404).json({ error: "Booking non trovato" });
    res.json({ booking });
  } catch (err) { next(err); }
});

router.delete("/bookings/:id", async (req, res, next) => {
  try {
    const booking = await cancelBooking(req.tenant.siteId, req.params.id);
    res.json({ booking });
  } catch (err) { next(err); }
});

// ── Booking Calendar Config (ONDA 2) ───────────────────────────────────
// Gestione della configurazione di sincronizzazione booking ↔ Google Calendar.
// Al massimo una config attiva per tenant. POST crea, GET/PUT/DELETE gestiscono.

router.get("/booking-calendar-config", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const config = (await query(
      "SELECT * FROM booking_calendar_config WHERE site_id = $1 AND active = true LIMIT 1",
      [siteId]
    )).rows[0];
    res.json({ config: config || null });
  } catch (err) { next(err); }
});

router.post("/booking-calendar-config", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const oauthConnectionId = parseInt(b.oauth_connection_id, 10);
    if (!Number.isInteger(oauthConnectionId) || oauthConnectionId < 1) {
      return res.status(400).json({ error: "oauth_connection_id è obbligatorio e deve essere un numero positivo" });
    }
    // Disattiva config precedente (se esiste) prima di crearne una nuova
    await query(
      "UPDATE booking_calendar_config SET active = false, updated_at = NOW() WHERE site_id = $1 AND active = true",
      [siteId]
    );
    const result = await query(
      `INSERT INTO booking_calendar_config (site_id, oauth_connection_id, calendar_id, active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [siteId, oauthConnectionId, String(b.calendar_id || "primary").trim().slice(0, 255), true]
    );
    res.status(201).json({ config: result.rows[0] });
  } catch (err) { next(err); }
});

router.put("/booking-calendar-config", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    const existing = (await query(
      "SELECT * FROM booking_calendar_config WHERE site_id = $1 AND active = true LIMIT 1",
      [siteId]
    )).rows[0];
    if (!existing) return res.status(404).json({ error: "Nessuna config attiva trovata" });
    const oauthConnectionId = b.oauth_connection_id !== undefined
      ? parseInt(b.oauth_connection_id, 10)
      : existing.oauth_connection_id;
    if (!Number.isInteger(oauthConnectionId) || oauthConnectionId < 1) {
      return res.status(400).json({ error: "oauth_connection_id non valido" });
    }
    const result = await query(
      `UPDATE booking_calendar_config
       SET oauth_connection_id = $1, calendar_id = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [
        oauthConnectionId,
        b.calendar_id !== undefined
          ? String(b.calendar_id).trim().slice(0, 255)
          : existing.calendar_id,
        existing.id,
      ]
    );
    res.json({ config: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete("/booking-calendar-config", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const existing = (await query(
      "SELECT * FROM booking_calendar_config WHERE site_id = $1 AND active = true LIMIT 1",
      [siteId]
    )).rows[0];
    if (!existing) return res.status(404).json({ error: "Nessuna config attiva trovata" });
    await query(
      "UPDATE booking_calendar_config SET active = false, updated_at = NOW() WHERE id = $1",
      [existing.id]
    );
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── Payment Links (ONDA 2) ────────────────────────────────────────────────

router.post("/payment-links/:id/mark-paid", async (req, res, next) => {
  try {
    const result = await markPaid(req.tenant.siteId, req.params.id, { by: "v1_api" });
    if (!result || !result.link) return res.status(404).json({ error: "Payment link non trovato" });
    res.json({ paymentLink: result.link, already: !!result.already });
  } catch (err) { next(err); }
});

router.post("/payment-links", async (req, res, next) => {
  try {
    const link = await createPaymentLink(req.tenant.siteId, req.body || {});
    if (!link) return res.status(400).json({ error: "Dati payment link non validi (title obbligatorio)" });
    res.status(201).json({ paymentLink: link });
  } catch (err) { next(err); }
});

router.get("/payment-links", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.query || {};
    const links = await listPaymentLinks(siteId, { status: b.status, contactEmail: b.contact_email, limit: b.limit, offset: b.offset });
    res.json({ paymentLinks: links, total: links.length });
  } catch (err) { next(err); }
});

router.get("/payment-links/:id", async (req, res, next) => {
  try {
    const link = await getPaymentLink(req.tenant.siteId, req.params.id);
    if (!link) return res.status(404).json({ error: "Payment link non trovato" });
    res.json({ paymentLink: link });
  } catch (err) { next(err); }
});

router.put("/payment-links/:id", async (req, res, next) => {
  try {
    const link = await updatePaymentLink(req.tenant.siteId, req.params.id, req.body || {});
    if (!link) return res.status(404).json({ error: "Payment link non trovato" });
    res.json({ paymentLink: link });
  } catch (err) { next(err); }
});

router.delete("/payment-links/:id", async (req, res, next) => {
  try {
    const deleted = await deletePaymentLink(req.tenant.siteId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Payment link non trovato" });
    res.json({ deleted: true, id: parseInt(req.params.id, 10) });
  } catch (err) { next(err); }
});

// ── Conversations (ONDA 2 Phase 5) ─────────────────────────────────
// Route statiche (GET /conversations) PRIMA di quelle con parametri.

router.get("/conversations", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const { email, channel, status } = req.query;
    const conversations = await listConversations(siteId, { email, channel, status });
    res.json({ conversations, total: conversations.length });
  } catch (err) { next(err); }
});

router.get("/conversations/:id", async (req, res, next) => {
  try {
    const conversation = await getConversation(req.tenant.siteId, req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversazione non trovata" });
    res.json({ conversation });
  } catch (err) { next(err); }
});

router.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    const result = await listConversationMessages(req.tenant.siteId, req.params.id);
    if (!result) return res.status(404).json({ error: "Conversazione non trovata" });
    res.json({ conversation: result.conversation, messages: result.messages });
  } catch (err) { next(err); }
});

router.post("/conversations/:id/messages", async (req, res, next) => {
  try {
    const b = req.body || {};
    const conversation = await getConversation(req.tenant.siteId, req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversazione non trovata" });
    const message = await addConversationMessage(
      req.tenant.siteId, conversation.contact_email, conversation.channel,
      { direction: b.direction || "out", subject: b.subject, body: b.body, meta: b.meta }
    );
    if (!message) return res.status(400).json({ error: "Impossibile aggiungere messaggio" });
    res.status(201).json({ message });
  } catch (err) { next(err); }
});

router.put("/conversations/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!["open", "pending", "closed"].includes(status)) {
      return res.status(400).json({ error: "status deve essere open|pending|closed" });
    }
    const conversation = await setConversationStatus(req.tenant.siteId, req.params.id, status);
    if (!conversation) return res.status(404).json({ error: "Conversazione non trovata" });
    res.json({ conversation });
  } catch (err) { next(err); }
});

router.delete("/conversations/:id", async (req, res, next) => {
  try {
    const n = await deleteConversation(req.tenant.siteId, req.params.id);
    if (!n) return res.status(404).json({ error: "Conversazione non trovata" });
    res.json({ deleted: true, id: parseInt(req.params.id, 10) });
  } catch (err) { next(err); }
});

// ── ONDA 3 — Dashboard / KPI ───────────────────────────────────────
router.get("/dashboard", async (req, res, next) => {
  try {
    const { range } = req.query;
    const kpis = await getKpis(req.tenant.siteId, { range });
    res.json(kpis);
  } catch (err) { next(err); }
});

// ── ONDA 3 — Funnel / conversioni ──────────────────────────────────
router.get("/funnel", async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const funnel = await getFunnel(req.tenant.siteId, { from, to });
    res.json({ funnel });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// ONDA 3 — Attività (log centralizzato da contact_events, per-tenant)
// ─────────────────────────────────────────────────────────────────────────

// Helper comune per leggere attività da contact_events.
async function fetchActivities(siteId, { email = null, eventType = null, from = null, to = null, limit = 50, offset = 0, cursor = null } = {}) {
  const params = [siteId];
  let where = "WHERE site_id = $1";
  if (email) { params.push(email); where += ` AND email = $${params.length}`; }
  if (eventType) {
    // event_type è un singolo valore; chi vuole più tipi passa un CSV.
    const types = String(eventType).split(",").map((s) => s.trim()).filter(Boolean);
    if (types.length) {
      where += ` AND event_type = ANY($${params.length + 1}::varchar[])`;
      params.push(types);
    }
  }
  if (from) {
    params.push(from);
    where += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    where += ` AND created_at <= $${params.length}`;
  }
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    // Paginazione a cursore (keyset su id DESC, più efficiente dell'offset).
    params.push(parseInt(cursor, 10) || 0);
    where += ` AND id < $${params.length}`;
  }
  const tIdx = params.length + 1;
  const offIdx = params.length + 2;
  const rows = (await query(
    `SELECT id, email, event_type, payload, created_at FROM contact_events ${where}
     ORDER BY id DESC LIMIT $${tIdx} OFFSET $${offIdx}`,
    [...params, limit, offset]
  )).rows;

  const total = (await query(
    `SELECT COUNT(*)::int AS total FROM contact_events ${where}`,
    params
  )).rows[0].total;

  const nextCursor = rows.length === limit ? (rows[rows.length - 1].id) : null;
  return { activities: rows, total, nextCursor };
}

router.get("/activities", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const q = req.query || {};
    const lim = Math.min(parseInt(q.limit, 10) || 50, 200);
    const off = parseInt(q.offset, 10) || 0;
    const email = q.email || q.contactEmail || null;
    const { activities, total, nextCursor } = await fetchActivities(siteId, {
      email, eventType: q.eventType, from: q.from || q.startDate || null,
      to: q.to || q.endDate || null, limit: lim, offset: off, cursor: q.cursor,
    });
    // Export CSV (?format=csv) → text/csv con download header.
    if (String(q.format || "").toLowerCase() === "csv") {
      const csv = toCsv(activities, [
        { key: "id", label: "id" },
        { key: "email", label: "email" },
        { key: "event_type", label: "event_type" },
        { key: "payload", label: "payload" },
        { key: "created_at", label: "created_at" },
      ]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=activities.csv");
      return res.send(csv);
    }
    res.json({ activities, total, nextCursor });
  } catch (err) { next(err); }
});

router.get("/contacts/:id/activities", async (req, res, next) => {
  try {
    const contact = await getContact(req.tenant.siteId, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contatto non trovato" });
    const result = await fetchActivities(req.tenant.siteId, { email: contact.email, limit: 50, offset: 0 });
    res.json({ activities: result.activities });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// ONDA 3 — Statistiche email (aggregate tenant + per campagna)
// ─────────────────────────────────────────────────────────────────────────

router.get("/email-stats", async (req, res, next) => {
  try {
    const stats = await getEmailStatsAggregate(req.tenant.siteId);
    res.json({ emailStats: stats });
  } catch (err) { next(err); }
});

router.get("/email-stats/campaigns", async (req, res, next) => {
  try {
    const campaigns = await listEmailStatsCampaigns(req.tenant.siteId);
    if (String((req.query || {}).format || "").toLowerCase() === "csv") {
      const csv = toCsv(campaigns, [
        { key: "id", label: "id" },
        { key: "subject", label: "subject" },
        { key: "status", label: "status" },
        { key: "created_at", label: "created_at" },
        { key: "sent_at", label: "sent_at" },
        { key: "total", label: "sent" },
        { key: "opened", label: "opened" },
        { key: "clickers", label: "clickers" },
        { key: "clicks", label: "clicks" },
        { key: "open_rate", label: "open_rate" },
        { key: "click_rate", label: "click_rate" },
        { key: "ctor", label: "ctor" },
      ]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=email-stats-campaigns.csv");
      return res.send(csv);
    }
    res.json({ campaigns });
  } catch (err) { next(err); }
});

router.get("/email-stats/campaigns/:id", async (req, res, next) => {
  try {
    const stats = await getEmailStatsCampaign(req.tenant.siteId, req.params.id);
    if (!stats || stats.error) return res.status(404).json({ error: stats?.error || "Campagna non trovata" });
    res.json({ emailStats: stats });
  } catch (err) { next(err); }
});

router.get("/email-stats/sequences", async (req, res, next) => {
  try {
    const sequences = await listEmailStatsSequences(req.tenant.siteId);
    if (String((req.query || {}).format || "").toLowerCase() === "csv") {
      const csv = toCsv(sequences, [
        { key: "id", label: "id" },
        { key: "name", label: "name" },
        { key: "active", label: "active" },
        { key: "steps", label: "steps" },
        { key: "total", label: "sent" },
        { key: "opened", label: "opened" },
        { key: "clickers", label: "clickers" },
        { key: "open_rate", label: "open_rate" },
        { key: "click_rate", label: "click_rate" },
        { key: "ctor", label: "ctor" },
      ]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=email-stats-sequences.csv");
      return res.send(csv);
    }
    res.json({ sequences });
  } catch (err) { next(err); }
});

router.get("/email-stats/sequences/:id", async (req, res, next) => {
  try {
    const stats = await getEmailStatsSequence(req.tenant.siteId, req.params.id);
    if (!stats || stats.error) return res.status(404).json({ error: stats?.error || "Sequenza non trovata" });
    res.json({ emailStats: stats });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// ONDA 3 — Report (config CRUD + generazione dry-run + storico run)
// ─────────────────────────────────────────────────────────────────────────

router.get("/reports", async (req, res, next) => {
  try {
    const reports = await listReportConfigs(req.tenant.siteId);
    res.json({ reports });
  } catch (err) { next(err); }
});

router.post("/reports", async (req, res, next) => {
  try {
    const report = await createReportConfig(req.tenant.siteId, req.body || {});
    res.status(201).json({ report });
  } catch (err) { next(err); }
});

router.get("/reports/:id/runs", async (req, res, next) => {
  try {
    const { limit } = req.query || {};
    const runs = await listRuns(req.tenant.siteId, req.params.id, { limit: parseInt(limit, 10) || 50 });
    res.json({ runs });
  } catch (err) { next(err); }
});

router.get("/reports/:id", async (req, res, next) => {
  try {
    const report = await getReportConfig(req.tenant.siteId, req.params.id);
    if (!report) return res.status(404).json({ error: "Report non trovato" });
    res.json({ report });
  } catch (err) { next(err); }
});

router.put("/reports/:id", async (req, res, next) => {
  try {
    const report = await updateReportConfig(req.tenant.siteId, req.params.id, req.body || {});
    if (!report) return res.status(404).json({ error: "Report non trovato" });
    res.json({ report });
  } catch (err) { next(err); }
});

router.delete("/reports/:id", async (req, res, next) => {
  try {
    const id = await deleteReportConfig(req.tenant.siteId, req.params.id);
    if (!id) return res.status(404).json({ error: "Report non trovato" });
    res.json({ deleted: true, id: parseInt(req.params.id, 10) });
  } catch (err) { next(err); }
});

// POST /reports/:id/run → generazione DRY-RUN (NON invia email SMTP): utile
// per l'agente/consumer per ottenere i dati del report senza inviare nulla.
router.post("/reports/:id/run", async (req, res, next) => {
  try {
    const report = await generateReport(req.tenant.siteId, req.params.id);
    if (!report) return res.status(404).json({ error: "Report non trovato" });
    res.json({ report });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// ONDA 2/3 — Import dati (bulk upsert) collegato al tool di import
// POST /v1/import  → importCrmData (contatti + task upsert per email) o
//                    importFromFile (upload CSV/JSON via multipart o body
//                    text/csv). Fino a 10MB di file in memoria.
// Varianti supportate:
//   1) body JSON   { contacts: [...], tasks: [...], created_by }   (upsert)
//   2) multipart/form-data  con campo `file` (CSV o JSON) + `created_by`
//   3) body text/csv  → contatti, prima riga = colonne
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single("file");

// Legge il body grezzo come stringa (per text/csv, che express.json non
// parsa). Conciliando: multer.single consuma il body SOLO per multipart;
// per gli altri content-type il stream resta leggibile qui.
function readRawBody(req) {
  return new Promise((resolve) => {
    // express.text({type:"text/csv"}) setta req.body = stringa se content-type
    // matching; per altri content-type il body è già stato parsato da express.json.
    if (typeof req.body === "string") return resolve(req.body);
    if (Buffer.isBuffer(req.body)) return resolve(req.body.toString("utf8"));
    resolve("");
  });
}

router.post("/import", importUpload, async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const contentType = (req.get("Content-Type") || "").toLowerCase();

    // Caso multipart: file in req.file.buffer
    if (req.file && req.file.buffer) {
      const result = await importFromFile(siteId, {
        filename: req.file.originalname || "upload.dat",
        text: req.file.buffer.toString("utf8"),
        created_by: (req.body && (req.body.created_by || req.body.createdBy)) || "",
      });
      res.status(201).json(result);
      return;
    }

    // Caso text/csv o application/octet-stream da body grezzo: usiamo
    // importFromFile che deduce la tipologia (estensioni/contenuto).
    if (contentType.includes("text/csv")) {
      const rawText = await readRawBody(req);
      const result = await importFromFile(siteId, {
        filename: req.query.filename || "import.csv",
        text: rawText,
        created_by: (req.body && (req.body.created_by || req.body.createdBy)) || "",
      });
      res.status(201).json(result);
      return;
    }

    // Caso JSON attuale (backward compatible)
    const body = req.body || {};
    const created_by = body.createdBy || body.created_by || "";
    const result = await importCrmData(siteId, {
      contacts: Array.isArray(body.contacts) ? body.contacts : [],
      tasks: Array.isArray(body.tasks) ? body.tasks : [],
      created_by: String(created_by),
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.get("/import/jobs", async (req, res, next) => {
  try {
    const { limit } = req.query || {};
    const jobs = await listImportJobs(req.tenant.siteId, { limit: parseInt(limit, 10) || 50 });
    res.json({ jobs });
  } catch (err) { next(err); }
});

router.get("/import/jobs/:id", async (req, res, next) => {
  try {
    const job = await getImportJob(req.tenant.siteId, req.params.id);
    if (!job) return res.status(404).json({ error: "Job di import non trovato" });
    res.json({ job });
  } catch (err) { next(err); }
});

export default router;
