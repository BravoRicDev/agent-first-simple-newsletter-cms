import crypto from "crypto";
import { Router } from "express";
import { query } from "../db.js";
import { requireTenant } from "../middleware/tenant-api.js";
import {
  listCustomFields, getCustomField, createCustomField,
  updateCustomField, deleteCustomField, listByObjectKey,
} from "../services/custom-fields.js";
import { listCapabilities } from "../services/capabilities.js";
import { getBoardPipelines } from "../services/opportunities.js";

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

export default router;
