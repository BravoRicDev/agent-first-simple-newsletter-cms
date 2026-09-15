import { query } from "../db.js";
import { previewSegment } from "./segments.js";
import { testWorkflow } from "./workflows.js";
import { testRuntime } from "./agent-runtime.js";
import { runSandboxTest } from "./agent-builder.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 42 — Sandbox/staging.
//
// Dry-run di segmenti, workflow, agenti e preventivi SENZA side-effect:
// ogni esecuzione (runSandbox) valida l'input, delega il calcolo al
// sottosistema competente e registra SOLO una riga in sandbox_runs
// (kind, input, output) per lo storico. Nessun contatto/task/conversazione
// viene creato o modificato.
//
// sandbox_scenarios: scenari riutilizzabili (kind + input salvati) per
// rieseguire lo stesso test in un secondo momento.
// ─────────────────────────────────────────────────────────────────────────

const KINDS = new Set(["segment", "workflow", "agent", "quote"]);
const MAX_INPUT_BYTES = 100 * 1024; // 100 KB

// Input sempre oggetto, mai oltre 100KB (JSON serializzato).
function sanitizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  let json;
  try {
    json = JSON.stringify(input);
  } catch {
    return {};
  }
  if (json.length > MAX_INPUT_BYTES) return { error: "Input troppo grande (max 100KB)" };
  return input;
}

// Preventivo in dry-run: valida le righe e calcola il totale, nessun
// salvataggio (nessuna riga in quotes/opportunities).
function previewQuote(items) {
  const rows = Array.isArray(items) ? items : [];
  const clean = [];
  for (const it of rows) {
    if (!it || typeof it !== "object") continue;
    const qty = Number(it.qty);
    const price = Number(it.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price < 0) {
      return {
        valid: false,
        error: "Ogni riga deve avere qty > 0 e price >= 0 numerici",
        total: 0,
        items: [],
      };
    }
    clean.push({
      description: String(it.description || "").trim().slice(0, 500) || `Riga ${clean.length + 1}`,
      qty,
      price,
      line_total: Math.round(qty * price * 100) / 100,
    });
  }
  if (clean.length === 0) {
    return { valid: false, error: "items richiesto con almeno una riga", total: 0, items: [] };
  }
  const total = Math.round(clean.reduce((sum, r) => sum + r.line_total, 0) * 100) / 100;
  return { valid: true, total, items: clean };
}

// ── Scenari riutilizzabili ───────────────────────────────────────────────

export async function listScenarios(siteId, { kind } = {}) {
  const params = [siteId];
  let sql = "SELECT * FROM sandbox_scenarios WHERE site_id = $1";
  if (kind && KINDS.has(kind)) {
    params.push(kind);
    sql += ` AND kind = $${params.length}`;
  }
  sql += " ORDER BY created_at DESC, id DESC";
  return (await query(sql, params)).rows;
}

export async function createScenario(siteId, { name, kind, input } = {}) {
  const cleanKind = String(kind || "");
  if (!KINDS.has(cleanKind)) return { error: "Kind non supportato" };
  const cleanName = String(name || "").trim().slice(0, 255);
  if (!cleanName) return { error: "Nome obbligatorio" };
  const cleanInput = sanitizeInput(input);
  const row = (await query(
    `INSERT INTO sandbox_scenarios (site_id, name, kind, input)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [siteId, cleanName, cleanKind, JSON.stringify(cleanInput)]
  )).rows[0];
  return { scenario: row };
}

export async function updateScenario(siteId, id, data = {}) {
  const current = (await query(
    "SELECT * FROM sandbox_scenarios WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (!current) return { notFound: true };
  const cleanKind = data.kind !== undefined ? String(data.kind) : current.kind;
  if (!KINDS.has(cleanKind)) return { error: "Kind non supportato" };
  const name = data.name !== undefined ? String(data.name).trim().slice(0, 255) : current.name;
  if (!name) return { error: "Nome obbligatorio" };
  const cleanInput = data.input !== undefined ? sanitizeInput(data.input) : current.input;
  const row = (await query(
    `UPDATE sandbox_scenarios SET name = $1, kind = $2, input = $3, updated_at = NOW()
     WHERE id = $4 AND site_id = $5 RETURNING *`,
    [name, cleanKind, JSON.stringify(cleanInput), parseInt(id, 10), siteId]
  )).rows[0];
  return { scenario: row };
}

export async function deleteScenario(siteId, id) {
  const result = await query(
    "DELETE FROM sandbox_scenarios WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  );
  return result.rowCount > 0;
}

// ── Dry-run ──────────────────────────────────────────────────────────────

// Esegue il dry-run in base al kind e registra la riga in sandbox_runs.
// Un errore interno NON crasha: viene registrato come output {error} e la
// risposta arriva comunque. Kind non valido → {error:'Kind non supportato'}
// (nessuna riga registrata).
export async function runSandbox({ siteId, kind, input, source = "manual" }) {
  const k = String(kind || "");
  if (!KINDS.has(k)) return { error: "Kind non supportato" };

  const safeInput = sanitizeInput(input);
  let output;
  let preRegisteredRunId = null;

  try {
    switch (k) {
      case "segment": {
        const rules = Array.isArray(safeInput.rules) ? safeInput.rules : [];
        const matchMode = safeInput.match_mode === "any" ? "any" : "all";
        output = await previewSegment(siteId, rules, matchMode);
        break;
      }
      case "workflow": {
        const workflowId = parseInt(safeInput.workflow_id, 10);
        output = await testWorkflow(siteId, workflowId, safeInput.email);
        break;
      }
      case "agent": {
        const definitionId = parseInt(safeInput.definition_id, 10);
        const runtimeId = parseInt(safeInput.runtime_id, 10);
        const message = String(safeInput.message || "").slice(0, 5000);
        const contactEmail = safeInput.contact_email || null;
        if (definitionId) {
          // runSandboxTest registra GIÀ la riga in sandbox_runs (kind
          // 'agent_test', agent_definition_id valorizzato): non duplichiamo.
          const res = await runSandboxTest({
            siteId,
            definitionId,
            message,
            contact_email: contactEmail,
          });
          preRegisteredRunId = res.sandbox_run_id || null;
          output = { reply: res.reply, definition_id: res.definition_id };
        } else if (runtimeId) {
          output = await testRuntime(siteId, runtimeId, { message, contactEmail });
        } else {
          output = { error: "runtime_id o definition_id obbligatorio" };
        }
        break;
      }
      case "quote": {
        output = previewQuote(safeInput.items);
        break;
      }
      default:
        output = { error: "Kind non supportato" };
    }
  } catch (err) {
    // Errore interno: mai crashare — registra l'errore e ritorna comunque.
    output = { error: err.message };
  }

  if (preRegisteredRunId) {
    return { sandbox_run_id: preRegisteredRunId, output };
  }

  try {
    const inserted = await query(
      `INSERT INTO sandbox_runs (site_id, agent_definition_id, kind, input, output)
       VALUES ($1, NULL, $2, $3, $4) RETURNING id`,
      [siteId, k, JSON.stringify(safeInput), JSON.stringify(output)]
    );
    return { sandbox_run_id: inserted.rows[0].id, output };
  } catch (err) {
    // Anche un fallimento del LOG non deve far perdere il risultato.
    return { sandbox_run_id: null, output, log_error: err.message };
  }
}

// ── Storico esecuzioni (riusa sandbox_runs) ──────────────────────────────

export async function listSandboxRuns(siteId, { kind, limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const params = [siteId];
  let sql = `SELECT id, site_id, agent_definition_id, kind, input, output, created_at
             FROM sandbox_runs WHERE site_id = $1`;
  if (kind && KINDS.has(kind)) {
    params.push(kind);
    sql += ` AND kind = $${params.length}`;
  }
  params.push(lim);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  return (await query(sql, params)).rows;
}

export async function getSandboxRun(siteId, id) {
  const row = (await query(
    `SELECT id, site_id, agent_definition_id, kind, input, output, created_at
     FROM sandbox_runs WHERE id = $1 AND site_id = $2`,
    [parseInt(id, 10), siteId]
  )).rows[0];
  return row || null;
}
