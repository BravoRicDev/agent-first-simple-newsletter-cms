import { query } from "../db.js";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 41 — Report periodici ai clienti.
//
// Una config per sito (report_configs) descrive un report automatico:
//   kind       → 'weekly' | 'monthly'
//   sections   → whitelist ['leads','pipeline','tasks','conversations','email']
//   recipients → array di email (max 20)
//   last_sent_at → usato da runDueReports() per decidere quali config sono
//                  in scadenza (7gg weekly, 30gg monthly).
//
// generateReport() raccoglie i dati per sezione con query dirette (NON
// dipende da dashboard.js: quella feature arriva in parallelo) e costruisce
// { json, html } SENZA inviare nulla. sendReport() genera, invia le email
// via sendEmail() (mai crash: ogni errore viene catturato), aggiorna
// last_sent_at SOLO se almeno un invio è andato a buon fine (così una
// config fallita viene ritentata al tick successivo dello scheduler) e
// registra una riga in report_runs con status 'ok' | 'error'.
// ─────────────────────────────────────────────────────────────────────────

const KINDS = new Set(["weekly", "monthly"]);
const SECTION_WHITELIST = new Set(["leads", "pipeline", "tasks", "conversations", "email"]);
const DEFAULT_SECTIONS = ["leads", "pipeline", "tasks"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 20;

const SECTION_LABELS = {
  leads: "Lead",
  pipeline: "Pipeline",
  tasks: "Task",
  conversations: "Conversazioni",
  email: "Email inviate",
};

// ── Sanitizzazione ───────────────────────────────────────────────────────

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function sanitizeKind(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!KINDS.has(value)) {
    throw validationError("Tipo report non valido: usare 'weekly' o 'monthly'");
  }
  return value;
}

function sanitizeSections(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_SECTIONS];
  const arr = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const clean = [];
  for (const item of arr) {
    const value = String(item ?? "").trim().toLowerCase();
    if (SECTION_WHITELIST.has(value) && !seen.has(value)) {
      seen.add(value);
      clean.push(value);
    }
  }
  return clean.length ? clean : [...DEFAULT_SECTIONS];
}

function sanitizeRecipients(raw) {
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const clean = [];
  for (const item of arr) {
    const value = String(item ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(value) && !seen.has(value) && clean.length < MAX_RECIPIENTS) {
      seen.add(value);
      clean.push(value);
    }
  }
  return clean;
}

function sanitizeName(raw) {
  const value = String(raw ?? "").trim().slice(0, 255);
  if (!value) throw validationError("Nome report obbligatorio");
  return value;
}

// ── CRUD config ──────────────────────────────────────────────────────────

export async function listConfigs(siteId) {
  return (await query(
    "SELECT * FROM report_configs WHERE site_id = $1 ORDER BY id",
    [siteId]
  )).rows;
}

export async function getConfig(siteId, id) {
  const row = (await query(
    "SELECT * FROM report_configs WHERE site_id = $1 AND id = $2",
    [siteId, id]
  )).rows[0];
  return row || null;
}

export async function createConfig(siteId, data = {}) {
  const name = sanitizeName(data.name);
  const kind = sanitizeKind(data.kind ?? "weekly");
  const sections = sanitizeSections(data.sections);
  const recipients = sanitizeRecipients(data.recipients);
  const active = data.active === undefined ? true : !!data.active;
  const result = await query(
    `INSERT INTO report_configs (site_id, name, kind, sections, recipients, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [siteId, name, kind, JSON.stringify(sections), JSON.stringify(recipients), active]
  );
  return result.rows[0];
}

export async function updateConfig(siteId, id, data = {}) {
  const current = await getConfig(siteId, id);
  if (!current) return null;
  const name = data.name !== undefined ? sanitizeName(data.name) : current.name;
  const kind = data.kind !== undefined ? sanitizeKind(data.kind) : current.kind;
  const sections = data.sections !== undefined
    ? sanitizeSections(data.sections) : (Array.isArray(current.sections) ? current.sections : DEFAULT_SECTIONS);
  const recipients = data.recipients !== undefined
    ? sanitizeRecipients(data.recipients) : (Array.isArray(current.recipients) ? current.recipients : []);
  const active = data.active !== undefined ? !!data.active : current.active;
  const result = await query(
    `UPDATE report_configs
        SET name = $1, kind = $2, sections = $3, recipients = $4,
            active = $5, updated_at = NOW()
      WHERE site_id = $6 AND id = $7 RETURNING *`,
    [name, kind, JSON.stringify(sections), JSON.stringify(recipients), active, siteId, id]
  );
  return result.rows[0] || null;
}

export async function deleteConfig(siteId, id) {
  const result = await query(
    "DELETE FROM report_configs WHERE site_id = $1 AND id = $2 RETURNING id",
    [siteId, id]
  );
  return result.rows[0] || null;
}

// ── Raccolta dati per sezione (query dirette, niente dashboard.js) ───────

async function sectionLeads(siteId) {
  const total = (await query(
    "SELECT COUNT(*)::int AS c FROM contacts WHERE site_id = $1",
    [siteId]
  )).rows[0].c;
  const newLeads7d = (await query(
    "SELECT COUNT(*)::int AS c FROM contacts WHERE site_id = $1 AND created_at >= NOW() - INTERVAL '7 days'",
    [siteId]
  )).rows[0].c;
  return { total, new_leads_7d: newLeads7d };
}

async function sectionPipeline(siteId) {
  const row = (await query(
    `SELECT COUNT(*)::int AS open_opportunities,
            COALESCE(SUM(amount * probability / 100.0), 0)::numeric AS pipeline_value
     FROM opportunities
     WHERE site_id = $1 AND status = 'open'`,
    [siteId]
  )).rows[0];
  return { open_opportunities: row.open_opportunities, pipeline_value: Number(row.pipeline_value) };
}

async function sectionTasks(siteId) {
  const open = (await query(
    "SELECT COUNT(*)::int AS c FROM tasks WHERE site_id = $1 AND status = 'open'",
    [siteId]
  )).rows[0].c;
  const done7d = (await query(
    "SELECT COUNT(*)::int AS c FROM tasks WHERE site_id = $1 AND done_at >= NOW() - INTERVAL '7 days'",
    [siteId]
  )).rows[0].c;
  return { tasks_open: open, tasks_done_7d: done7d };
}

async function sectionConversations(siteId) {
  const open = (await query(
    "SELECT COUNT(*)::int AS c FROM conversations WHERE site_id = $1 AND status = 'open'",
    [siteId]
  )).rows[0].c;
  return { conversations_open: open };
}

// newsletter_sends non ha site_id: si risale alla campagna. In try/catch
// perché le tabelle newsletter potrebbero mancare in un DB minimale: in
// quel caso la sezione ritorna null (renderizzato come "n/d"), mai crash.
async function sectionEmail(siteId) {
  try {
    const row = (await query(
      `SELECT COUNT(*)::int AS c
       FROM newsletter_sends ns
       JOIN newsletter_campaigns nc ON nc.id = ns.campaign_id
       WHERE nc.site_id = $1`,
      [siteId]
    )).rows[0];
    return { email_sent: row.c };
  } catch (err) {
    logger.warn(`Reports: sezione email non disponibile (site=${siteId}): ${err.message}`);
    return { email_sent: null };
  }
}

// ── HTML ─────────────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function formatValue(value) {
  if (value === null || value === undefined) return "n/d";
  if (typeof value === "number") {
    return new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2 }).format(value);
  }
  return value;
}

function buildHtml(config, data, generatedAt) {
  const kindLabel = config.kind === "monthly" ? "Mensile" : "Settimanale";
  const dateLabel = new Date(generatedAt).toLocaleDateString("it-IT", {
    day: "2-digit", month: "long", year: "numeric",
  });
  const rows = [];
  for (const section of Array.isArray(config.sections) ? config.sections : []) {
    const values = data[section] || {};
    for (const [key, value] of Object.entries(values)) {
      const label = `${SECTION_LABELS[section] || section}: ${key.replace(/_/g, " ")}`;
      rows.push([label, formatValue(value)]);
    }
  }
  const rowsHtml = rows.map(([label, value]) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">${esc(label)}</td>`
    + `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;text-align:right;color:#111827;">${esc(value)}</td></tr>`
  ).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f9fafb;">
  <div style="background:#ffffff;border-radius:8px;padding:24px;border:1px solid #e5e7eb;">
    <h2 style="margin:0 0 4px;color:#111827;">Report ${esc(config.name)}</h2>
    <p style="margin:0 0 20px;color:#6b7280;font-size:13px;">Report ${kindLabel.toLowerCase()} &middot; ${esc(dateLabel)}</p>
    <table style="border-collapse:collapse;width:100%;">
      ${rowsHtml}
    </table>
    <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;">Generato automaticamente dal CRM &middot; ${esc(dateLabel)}</p>
  </div>
</body></html>`;
}

// ── Generazione (dry-run: NON invia nulla) ───────────────────────────────

export async function generateReport(siteId, configId) {
  const config = await getConfig(siteId, configId);
  if (!config) return null;

  const sections = (Array.isArray(config.sections) ? config.sections : [])
    .filter(s => SECTION_WHITELIST.has(s));
  const data = {};
  for (const section of sections) {
    switch (section) {
      case "leads": data.leads = await sectionLeads(siteId); break;
      case "pipeline": data.pipeline = await sectionPipeline(siteId); break;
      case "tasks": data.tasks = await sectionTasks(siteId); break;
      case "conversations": data.conversations = await sectionConversations(siteId); break;
      case "email": data.email = await sectionEmail(siteId); break;
      default: break;
    }
  }

  const generatedAt = new Date();
  return {
    config_id: config.id,
    generated_at: generatedAt.toISOString(),
    json: data,
    html: buildHtml(config, data, generatedAt),
  };
}

// ── Invio email + log run ────────────────────────────────────────────────

export async function sendReport(siteId, configId) {
  const config = await getConfig(siteId, configId);
  if (!config) return { error: "Configurazione non trovata" };
  const report = await generateReport(siteId, configId);
  if (!report) return { error: "Configurazione non trovata" };

  const recipients = Array.isArray(config.recipients) ? config.recipients : [];
  if (!recipients.length) return { error: "Nessun destinatario" };

  const kindLabel = config.kind === "monthly" ? "Mensile" : "Settimanale";
  const dateLabel = new Date(report.generated_at).toLocaleDateString("it-IT");
  const subject = `Report ${config.name} - ${kindLabel} ${dateLabel}`;

  const errors = [];
  let sent = 0;
  for (const recipient of recipients) {
    try {
      await sendEmail(recipient, subject, report.html);
      sent++;
    } catch (err) {
      // SMTP assente/irraggiungibile o qualunque errore di invio: NON deve
      // mai crashare la richiesta né bloccare gli altri destinatari.
      errors.push(`${recipient}: ${err?.message || String(err)}`);
    }
  }

  const status = errors.length ? "error" : "ok";
  const errorText = errors.join(" | ").slice(0, 2000);

  // last_sent_at solo se almeno un invio è andato a buon fine: una config
  // con tutti gli invii falliti resta "scaduta" e verrà ritentata da
  // runDueReports() al prossimo tick dello scheduler.
  if (sent > 0) {
    await query(
      "UPDATE report_configs SET last_sent_at = NOW(), updated_at = NOW() WHERE id = $1 AND site_id = $2",
      [configId, siteId]
    ).catch(err => logger.error(`Reports: aggiornamento last_sent_at fallito (config=${configId}): ${err.message}`));
  }

  // Il log del run non deve mai far fallire la risposta.
  await query(
    "INSERT INTO report_runs (site_id, config_id, status, error) VALUES ($1, $2, $3, $4)",
    [siteId, configId, status, errorText]
  ).catch(err => logger.error(`Reports: registrazione run fallita (config=${configId}): ${err.message}`));

  return { sent, errors };
}

// ── Storico run ──────────────────────────────────────────────────────────

export async function listRuns(siteId, configId, { limit = 50 } = {}) {
  const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  return (await query(
    `SELECT * FROM report_runs
      WHERE site_id = $1 AND config_id = $2
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [siteId, configId, l]
  )).rows;
}

// ── Scheduler: config in scadenza ────────────────────────────────────────
// La aggancia il padre in src/services/scheduler.js (import dinamico),
// come le altre feature: qui NON tocchiamo scheduler.js.
// Ritorna { sent, failed } con il numero di config processate con successo
// (almeno un invio ok) e quelle fallite (nessun destinatario, errori di
// invio, o eccezione inattesa).

export async function runDueReports() {
  const due = (await query(
    `SELECT id, site_id, name, kind
     FROM report_configs
     WHERE active = true
       AND (last_sent_at IS NULL
            OR (kind = 'weekly' AND last_sent_at < NOW() - INTERVAL '7 days')
            OR (kind = 'monthly' AND last_sent_at < NOW() - INTERVAL '30 days'))`
  )).rows;

  let sent = 0;
  let failed = 0;
  for (const config of due) {
    try {
      const result = await sendReport(config.site_id, config.id);
      if (result.error || (Array.isArray(result.errors) && result.errors.length > 0) || result.sent === 0) {
        failed++;
      } else {
        sent++;
      }
    } catch (err) {
      logger.error(`Reports: invio programmato fallito (config=${config.id}): ${err.message}`);
      failed++;
    }
  }
  return { sent, failed };
}
