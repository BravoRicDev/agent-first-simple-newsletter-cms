import { query } from "../db.js";
import { createTask } from "./tasks.js";
import { buildCsv, parseCsv } from "./csv.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 39 — Export/import completo del CRM.
//
// Export: dump JSON multi-tabella (contatti, task, opportunità, preventivi,
// conversazioni, eventi, KB, segmenti, payment link, riepiloghi chiamate,
// suggerimenti risposta) o CSV dei contatti, con il massimo di 10000 righe
// per tabella e query SEMPRE parametrizzate (nessuna interpolazione: i nomi
// tabella passano dalla whitelist EXPORT_TABLES, mai dal chiamante).
//
// Import: upsert contatti per email (ON CONFLICT) + task, con validazione
// email e log persistente in import_jobs (kind 'contacts' | 'crm').
// ─────────────────────────────────────────────────────────────────────────

const EXPORT_LIMIT = 10000;

// Whitelist delle tabelle esportabili + colonne. Per `contacts` la lista è
// esplicita (i campi CRM davvero utili a un round-trip, niente colonne
// interne come pref_token); per le altre SELECT * — tutte hanno site_id.
// NB: non esiste una colonna `name` su contacts (lo schema ha solo email/
// tags/status/notes/...): il campo `name` è accettato in ingresso dagli
// import ma non persiste (documentato nei tool MCP).
const EXPORT_TABLES = {
  contacts: [
    "id", "email", "tags", "status", "notes", "value_estimate", "score",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "first_source",
    "pref_email", "pref_sms", "pref_phone", "pref_whatsapp", "pref_marketing",
    "created_at", "updated_at",
  ],
  tasks: null,
  opportunities: null,
  quotes: null,
  conversations: null,
  contact_events: null,
  kb_articles: null,
  segments: null,
  payment_links: null,
  call_summaries: null,
  reply_suggestions: null,
};

export function isExportableTable(name) {
  return Object.prototype.hasOwnProperty.call(EXPORT_TABLES, name);
}

export const EXPORTABLE_TABLES = Object.keys(EXPORT_TABLES);

// Header del CSV contatti (buildCsv gestisce escaping + anti-injection).
const CSV_COLUMNS = [
  { key: "email", label: "email" },
  { key: "name", label: "name" },
  { key: "tags", label: "tags" },
  { key: "status", label: "status" },
  { key: "notes", label: "notes" },
  { key: "value_estimate", label: "value_estimate" },
  { key: "score", label: "score" },
  { key: "utm_source", label: "utm_source" },
  { key: "utm_medium", label: "utm_medium" },
  { key: "utm_campaign", label: "utm_campaign" },
  { key: "utm_term", label: "utm_term" },
  { key: "utm_content", label: "utm_content" },
  { key: "created_at", label: "created_at" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Export ───────────────────────────────────────────────────────────────

// Esporta le tabelle richieste (default: tutte). Le tabelle non ammesse
// vengono IGNORATE (la route restituisce 400 se l'agente ne chiede una non
// supportata, così un typo non produce un export vuoto silenzioso).
export async function exportSiteData(siteId, { tables = [] } = {}) {
  const wanted = Array.isArray(tables) && tables.length > 0
    ? [...new Set(tables)].filter(isExportableTable)
    : EXPORTABLE_TABLES;

  const out = { site_id: siteId, exported_at: new Date().toISOString(), tables: {} };
  for (const table of wanted) {
    const columns = EXPORT_TABLES[table] ? EXPORT_TABLES[table].join(", ") : "*";
    const rows = (await query(
      `SELECT ${columns} FROM ${table} WHERE site_id = $1 ORDER BY id LIMIT ${EXPORT_LIMIT}`,
      [siteId]
    )).rows;
    out.tables[table] = rows;
  }
  return out;
}

// CSV dei contatti: header fisso (email,name,tags,status,notes,
// value_estimate,score,utm_*,created_at). tags (array pg) → stringa
// separata da virgola. `name` è sempre vuoto: il contatto non ha una
// colonna name nello schema.
export async function exportCsv(siteId) {
  const rows = (await query(
    `SELECT email, tags, status, notes, value_estimate, score,
            utm_source, utm_medium, utm_campaign, utm_term, utm_content, created_at
     FROM contacts WHERE site_id = $1 ORDER BY id LIMIT ${EXPORT_LIMIT}`,
    [siteId]
  )).rows;
  const flat = rows.map(r => ({
    ...r,
    tags: Array.isArray(r.tags) ? r.tags.join(",") : String(r.tags || ""),
  }));
  return buildCsv(CSV_COLUMNS, flat);
}

// ── Import (core, senza job) ─────────────────────────────────────────────

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map(t => String(t).trim()).filter(Boolean).slice(0, 50);
  }
  if (typeof tags === "string") {
    return tags.split(",").map(t => t.trim()).filter(Boolean).slice(0, 50);
  }
  return [];
}

function toNum(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Upsert di un singolo contatto per email (name non persiste: nessuna
// colonna nello schema — ignorato senza errore).
async function upsertContactRow(siteId, raw) {
  const email = String(raw?.email || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "email mancante o non valida" };
  }
  await query(
    `INSERT INTO contacts (site_id, email, tags, status, notes, value_estimate, score,
                           utm_source, utm_medium, utm_campaign, utm_term, utm_content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (site_id, email) DO UPDATE SET
       tags = $3, status = $4, notes = $5, value_estimate = $6, score = $7,
       utm_source = $8, utm_medium = $9, utm_campaign = $10,
       utm_term = $11, utm_content = $12, updated_at = NOW()`,
    [
      siteId, email,
      normalizeTags(raw.tags),
      String(raw.status || "").slice(0, 100),
      String(raw.notes || "").slice(0, 5000),
      toNum(raw.value_estimate, null),
      Math.max(0, Math.min(1000, parseInt(toNum(raw.score, 0), 10) || 0)),
      String(raw.utm_source || "").slice(0, 255),
      String(raw.utm_medium || "").slice(0, 255),
      String(raw.utm_campaign || "").slice(0, 255),
      String(raw.utm_term || "").slice(0, 255),
      String(raw.utm_content || "").slice(0, 255),
    ]
  );
  return { ok: true };
}

const MAX_ERRORS = 20;

// Importa righe contatti → { imported, skipped, errors } (senza job).
// lineOffset: numero di riga fisica nel file sorgente (0 = righe senza
// header, 1+ = header già consumato), per un report `line` accurato.
async function importContactRows(siteId, rows, lineOffset = 0) {
  let imported = 0;
  let skipped = 0;
  const errors = [];
  if (!Array.isArray(rows)) rows = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const res = await upsertContactRow(siteId, rows[i]);
      if (res.ok) {
        imported++;
      } else {
        skipped++;
        if (errors.length < MAX_ERRORS) errors.push({ row: i, line: lineOffset + i + 1, error: res.error });
      }
    } catch (err) {
      skipped++;
      if (errors.length < MAX_ERRORS) errors.push({ row: i, line: lineOffset + i + 1, error: err.message });
    }
  }
  return { imported, skipped, errors };
}

// Importa righe task → { imported, skipped, errors }. Ogni riga: title
// obbligatorio, email, due_at, notes.
async function importTaskRows(siteId, rows, created_by = "", lineOffset = 0) {
  let imported = 0;
  let skipped = 0;
  const errors = [];
  if (!Array.isArray(rows)) rows = [];
  // created_by arriva come email (es. req.user.email): createTask vuole un
  // id utente numerico — usiamo l'id solo se il payload lo fornisce.
  const createdById = /^\d+$/.test(String(created_by)) ? parseInt(created_by, 10) : null;
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const title = String(raw.title || "").trim().slice(0, 255);
    if (!title) {
      skipped++;
      if (errors.length < MAX_ERRORS) errors.push({ row: i, line: lineOffset + i + 1, error: "title obbligatorio" });
      continue;
    }
    try {
      await createTask(siteId, {
        title,
        email: raw.email || "",
        dueAt: raw.due_at || raw.dueAt || null,
        notes: raw.notes || "",
        createdBy: raw.created_by ? parseInt(raw.created_by, 10) || null : createdById,
      });
      imported++;
    } catch (err) {
      skipped++;
      if (errors.length < MAX_ERRORS) errors.push({ row: i, line: lineOffset + i + 1, error: err.message });
    }
  }
  return { imported, skipped, errors };
}

async function insertImportJob(siteId, kind, stats, created_by = "", filename = "") {
  const result = await query(
    `INSERT INTO import_jobs (site_id, kind, filename, status, stats, error, created_by)
     VALUES ($1, $2, $3, 'done', $4, '', $5) RETURNING *`,
    [siteId, kind, String(filename || "").slice(0, 255), JSON.stringify(stats), String(created_by || "").slice(0, 255)]
  );
  return result.rows[0];
}

// ── Import (pubblici, con job) ───────────────────────────────────────────

// Import contatti (upsert per email). Ritorna { job_id, imported, skipped, errors }.
export async function importContacts(siteId, { rows = [], created_by = "", filename = "" } = {}) {
  const res = await importContactRows(siteId, rows);
  const job = await insertImportJob(siteId, "contacts", res, created_by, filename);
  return { job_id: job.id, imported: res.imported, skipped: res.skipped, errors: res.errors };
}

// Import CRM completo: contatti + task in un unico job (kind 'crm').
// Ritorna { job_id, imported, skipped, tasks_imported, tasks_skipped, errors }.
export async function importCrmData(siteId, { contacts = [], tasks = [], created_by = "", filename = "", lineOffset = 0 } = {}) {
  const c = await importContactRows(siteId, contacts, lineOffset);
  const t = await importTaskRows(siteId, tasks, created_by, lineOffset);
  const errors = [...c.errors, ...t.errors].slice(0, MAX_ERRORS);
  const stats = {
    imported: c.imported, skipped: c.skipped,
    tasks_imported: t.imported, tasks_skipped: t.skipped,
    errors,
  };
  const job = await insertImportJob(siteId, "crm", stats, created_by, filename);
  return {
    job_id: job.id,
    imported: c.imported, skipped: c.skipped,
    tasks_imported: t.imported, tasks_skipped: t.skipped,
    errors,
  };
}

// ── Import da file (CSV/JSON) ────────────────────────────────────────────
// Decodifica il contenuto di un file (stringa) e importa i dati. Supporta:
//   - CSV  → header = colonne; ogni riga è un contatto (upsert per email).
//   - JSON → array di contatti oppure { contacts, tasks } (upsert per email).
// La tipologia è dedotta dall'estensione del filename, con fallback sul
// primo carattere (`{`/`[` → JSON, altrimenti CSV). filename viene
// registrato nel job di import per il report.
export async function importFromFile(siteId, { filename = "", text = "", created_by = "" } = {}) {
  const name = String(filename || "").toLowerCase();
  const isJsonName = /\.json$/i.test(name);
  const isCsvName = /\.csv$/i.test(name);
  const trimmed = String(text ?? "").trimStart();
  const looksJson = isJsonName || trimmed.startsWith("{") || trimmed.startsWith("[");
  const looksCsv = isCsvName || (!looksJson && trimmed.startsWith(",") === false && trimmed.length > 0);

  let contacts = [];
  let tasks = [];
  let lineOffset = 0;

  if (looksJson) {
    let parsed;
    try {
      parsed = JSON.parse(String(text ?? ""));
    } catch (err) {
      const job = await insertImportJob(siteId, "crm",
        { imported: 0, skipped: 0, tasks_imported: 0, tasks_skipped: 0, errors: [{ row: 0, line: 1, error: `JSON non valido: ${err.message}` }] },
        created_by, filename);
      return { job_id: job.id, imported: 0, skipped: 0, tasks_imported: 0, tasks_skipped: 0, errors: [{ row: 0, line: 1, error: `JSON non valido: ${err.message}` }] };
    }
    if (Array.isArray(parsed)) {
      contacts = parsed;
    } else if (parsed && typeof parsed === "object") {
      contacts = Array.isArray(parsed.contacts) ? parsed.contacts : [];
      tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    }
  } else if (looksCsv) {
    const rows = parseCsv(String(text ?? ""), { hasHeader: true });
    contacts = rows;
    lineOffset = 1; // la prima riga del CSV è l'header
  }

  return importCrmData(siteId, { contacts, tasks, created_by, filename, lineOffset });
}

// ── Log job ──────────────────────────────────────────────────────────────

export async function listImportJobs(siteId, { limit = 50 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = (await query(
    `SELECT * FROM import_jobs WHERE site_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [siteId, n]
  )).rows;
  return rows;
}

export async function getImportJob(siteId, id) {
  const row = (await query(
    "SELECT * FROM import_jobs WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  return row || null;
}
