import { query } from "../db.js";
import config from "../config.js";
import { complete } from "./llm.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 33 — Riepilogo IA delle chiamate.
// Data una chiamata (calls), genera un riassunto, le azioni da intraprendere
// e il prossimo passo. Con LLM_API_KEY configurata usa services/llm.js
// (complete) chiedendo JSON strutturato; senza chiave (o se la chiamata LLM
// fallisce) degrada silenziosamente a un template deterministico. Un solo
// riepilogo per chiamata (UNIQUE site_id+call_id): la rigenerazione fa
// upsert, la correzione manuale (updateSummary) non cambia mai la source.
// ─────────────────────────────────────────────────────────────────────────

const SUMMARY_STATUSES = new Set(["pending", "done"]);
const SUMMARY_SOURCES = new Set(["llm", "human"]);

// Parsing robusto del JSON restituito dal modello: il modello può includere
// markdown fence (```json ... ```), testo prima/dopo o parentesi non
// bilanciate. Ritorna { summary, action_items, next_step } con fallback
// sicuri su ogni campo.
function parseLlmResult(raw) {
  let text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  let data = null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  data = tryParse(text);
  if (!data) {
    // Ultimo tentativo: oggetto più esterno { ... } nel testo.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) data = tryParse(text.slice(start, end + 1));
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { summary: text.slice(0, 4000), action_items: [], next_step: "" };
  }
  const items = Array.isArray(data.action_items)
    ? data.action_items.filter(i => typeof i === "string").map(i => i.trim()).filter(Boolean)
    : [];
  return {
    summary: String(data.summary || text.slice(0, 4000)).trim().slice(0, 4000),
    action_items: items.slice(0, 50),
    next_step: String(data.next_step || "").trim().slice(0, 1000),
  };
}

function buildPrompt(call) {
  const esito = String(call.outcome_notes || "").trim() || String(call.status || "");
  const note = String(call.outcome_notes || "").trim() || "nessuna";
  return [
    "Riepiloga la seguente chiamata commerciale per il CRM.",
    "Restituisci SOLO JSON valido, senza markdown, con questa forma esatta:",
    '{"summary": "...", "action_items": ["..."], "next_step": "..."}',
    "- summary: riassunto conciso in italiano (max 80 parole).",
    "- action_items: array di stringhe con le azioni da intraprendere.",
    "- next_step: prossimo passo consigliato (stringa, anche vuota).",
    "Dati della chiamata:",
    `- Contatto: ${call.email}${call.name ? " (" + call.name + ")" : ""}`,
    `- Data: ${new Date(call.scheduled_at).toISOString()}`,
    `- Esito/Note: ${esito}`,
  ].join("\n");
}

// Genera (o rigenera con force) il riepilogo di una chiamata.
// Ritorna { row } con la riga {id, summary, action_items, next_step, source};
// { error: 'Chiamata non trovata' } se la chiamata non esiste nel sito;
// { exists: true, row } se un riepilogo esiste già e force=false.
export async function generateSummary(siteId, callId, { force = false } = {}) {
  const call = (await query(
    "SELECT id, email, name, scheduled_at, status, outcome_notes FROM calls WHERE id = $1 AND site_id = $2",
    [parseInt(callId, 10), siteId]
  )).rows[0];
  if (!call) return { error: "Chiamata non trovata" };

  const existing = (await query(
    "SELECT id FROM call_summaries WHERE site_id = $1 AND call_id = $2",
    [siteId, call.id]
  )).rows[0];
  if (existing && !force) return { exists: true, row: existing };

  const prompt = buildPrompt(call);
  let summary = "";
  let actionItems = [];
  let nextStep = "";
  let source = "template";

  if (config.llmApiKey) {
    try {
      const raw = await complete(prompt, { temperature: 0.3, maxTokens: 500 });
      const parsed = parseLlmResult(raw);
      summary = parsed.summary;
      actionItems = parsed.action_items;
      nextStep = parsed.next_step;
      source = "llm";
    } catch {
      // Fallback silenzioso al template: il riepilogo non deve MAI far
      // fallire la richiesta per un problema del provider LLM.
    }
  }

  if (!summary) {
    const esito = String(call.outcome_notes || "").trim() || String(call.status || "");
    const note = String(call.outcome_notes || "").trim() || "nessuna";
    summary = `Chiamata con ${call.email} — ${esito}. Note: ${note}`;
  }

  const result = await query(
    `INSERT INTO call_summaries (site_id, call_id, summary, action_items, next_step, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (site_id, call_id)
     DO UPDATE SET summary = EXCLUDED.summary, action_items = EXCLUDED.action_items,
                   next_step = EXCLUDED.next_step, source = EXCLUDED.source, updated_at = NOW()
     RETURNING id, site_id, call_id, summary, action_items, next_step, source, status, created_at, updated_at`,
    [siteId, call.id, summary, JSON.stringify(actionItems), nextStep, source]
  );
  return { row: result.rows[0] };
}

export async function listSummaries(siteId, { status = null, call_id = null, limit = 50, offset = 0 } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (status && SUMMARY_STATUSES.has(status)) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (call_id) {
    params.push(parseInt(call_id, 10));
    where += ` AND call_id = $${params.length}`;
  }
  params.push(
    Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
    Math.max(parseInt(offset, 10) || 0, 0)
  );
  return (await query(
    `SELECT * FROM call_summaries WHERE ${where}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )).rows;
}

// Correzione manuale umana: modifica summary/action_items/next_step/status.
// La source NON cambia (un riepilogo resta 'llm' o 'template' anche se
// l'operatore lo sistema); status='done' marca il riepilogo come verificato.
// Ritorna la riga aggiornata o null se non trovata.
export async function updateSummary(siteId, id, { summary, action_items, next_step, status } = {}) {
  const current = (await query(
    "SELECT * FROM call_summaries WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (!current) return null;

  const cleanStatus = status !== undefined
    ? (SUMMARY_STATUSES.has(status) ? status : current.status)
    : current.status;
  const cleanSummary = summary !== undefined ? String(summary).slice(0, 4000) : current.summary;
  const cleanItems = action_items !== undefined
    ? (Array.isArray(action_items) ? action_items.filter(i => typeof i === "string").slice(0, 50) : current.action_items)
    : current.action_items;
  const cleanNext = next_step !== undefined ? String(next_step).slice(0, 1000) : current.next_step;

  const result = await query(
    `UPDATE call_summaries
     SET summary = $3, action_items = $4, next_step = $5, status = $6, updated_at = NOW()
     WHERE id = $1 AND site_id = $2
     RETURNING id, site_id, call_id, summary, action_items, next_step, source, status, created_at, updated_at`,
    [parseInt(id, 10), siteId, cleanSummary, JSON.stringify(cleanItems), cleanNext, cleanStatus]
  );
  return result.rows[0] || null;
}

export async function deleteSummary(siteId, id) {
  const result = await query(
    "DELETE FROM call_summaries WHERE id = $1 AND site_id = $2 RETURNING id",
    [parseInt(id, 10), siteId]
  );
  return result.rowCount > 0;
}
