import crypto from "crypto";
import { Router } from "express";
import { query } from "../db.js";
import { requireTenant } from "../middleware/tenant-api.js";
import {
  listCustomFields, getCustomField, createCustomField,
  updateCustomField, deleteCustomField, listByObjectKey,
} from "../services/custom-fields.js";
import { listCapabilities } from "../services/capabilities.js";
import { getBoardPipelines, listOpportunities, getOpportunity, createOpportunity, updateOpportunity, deleteOpportunity } from "../services/opportunities.js";
import {
  createContact, getContact, updateContact, deleteContact,
  listContacts, searchContacts, upsertContactByEmail, findDuplicateContacts,
  addContactNote, listContactNotes, deleteContactNote,
  listContactTags, addContactTags, removeContactTag,
} from "../services/contacts-v1.js";
import { listTasks, createTask, updateTask } from "../services/tasks.js";

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
router.use(requireTenant());

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
// ONDA 1 — Opportunità (riusa services/opportunities.js).
// ─────────────────────────────────────────────────────────────────────────

function serializeOpportunity(o) {
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
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

router.get("/opportunities", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const { status, stage, contactEmail } = req.query;
    const opportunities = await listOpportunities(siteId, { status, stage, email: contactEmail });
    res.json({ opportunities: opportunities.map(serializeOpportunity), total: opportunities.length });
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
    });
    if (!opp) return res.status(400).json({ error: "Dati opportunità non validi (contactEmail + title obbligatori)" });
    res.status(201).json({ opportunity: serializeOpportunity(opp) });
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
    res.json({ opportunities: opportunities.map(serializeOpportunity), total: opportunities.length });
  } catch (err) { next(err); }
});

router.post("/opportunities/upsert", async (req, res, next) => {
  try {
    const { siteId } = req.tenant;
    const b = req.body || {};
    if (!b.contactEmail || !b.title) return res.status(400).json({ error: "contactEmail + title obbligatori per upsert" });
    const list = await listOpportunities(siteId, { email: b.contactEmail });
    const match = list.find((o) => o.title === String(b.title).trim());
    if (match) {
      const opp = await updateOpportunity(siteId, match.id, {
        stage: b.stage, amount: b.amount, probability: b.probability,
        status: b.status, pipeline_id: b.pipelineId || b.pipeline_id,
        expected_close_at: b.expectedCloseDate || b.expected_close_at, notes: b.notes,
      });
      return res.json({ opportunity: serializeOpportunity(opp), created: false });
    }
    const opp = await createOpportunity(siteId, {
      email: b.contactEmail, pipeline_id: b.pipelineId || b.pipeline_id,
      stage: b.stage, title: b.title, amount: b.amount, probability: b.probability,
      expected_close_at: b.expectedCloseDate || b.expected_close_at, notes: b.notes,
    });
    if (!opp) return res.status(400).json({ error: "Dati opportunità non validi" });
    res.status(201).json({ opportunity: serializeOpportunity(opp), created: true });
  } catch (err) { next(err); }
});

router.get("/opportunities/:id", async (req, res, next) => {
  try {
    const opp = await getOpportunity(req.tenant.siteId, req.params.id);
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ opportunity: serializeOpportunity(opp) });
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
    const opp = await updateOpportunity(siteId, req.params.id, fields);
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ opportunity: serializeOpportunity(opp) });
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
    res.json({ opportunity: serializeOpportunity(updated) });
  } catch (err) { next(err); }
});

router.get("/opportunities/:id/followers", async (req, res, next) => {
  try {
    const opp = await getOpportunity(req.tenant.siteId, req.params.id);
    if (!opp) return res.status(404).json({ error: "Opportunità non trovata" });
    res.json({ followers: [] });
  } catch (err) { next(err); }
});

export default router;
