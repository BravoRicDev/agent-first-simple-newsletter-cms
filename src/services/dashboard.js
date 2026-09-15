// Feature 40 — Dashboard realtime CRM.
// KPI calcolati con query LIVE (niente snapshot): lead per canale, valore
// pipeline, SLA task, conversazioni aperte, stats email e attività recente.
// Le viste salvabili (dashboard_views) sono configurazioni JSONB di widget.
import { query } from "../db.js";

const RANGES = ["7d", "30d", "90d"];
const INTERVALS = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };
const DEFAULT_RANGE = "30d";

// ── Sanitizzazione config viste ─────────────────────────────────────────
// Config deve essere un oggetto con `widgets` array (max 20 elementi).
export function sanitizeViewConfig(config) {
  const obj = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const widgets = Array.isArray(obj.widgets) ? obj.widgets.slice(0, 20) : [];
  return { widgets };
}

// ── KPI (ognuno una query separata, eseguite in parallelo) ──────────────

// Contatti creati nel range.
async function kpiLeads(siteId, interval) {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM contacts
     WHERE site_id = $1 AND created_at >= NOW() - $2::interval`,
    [siteId, interval]
  );
  return result.rows[0].count;
}

// Lead per canale: utm_source (o 'direct' se null/vuoto).
async function kpiLeadsByChannel(siteId, interval) {
  const result = await query(
    `SELECT COALESCE(NULLIF(TRIM(utm_source), ''), 'direct') AS channel, COUNT(*)::int AS count
     FROM contacts
     WHERE site_id = $1 AND created_at >= NOW() - $2::interval
     GROUP BY channel
     ORDER BY count DESC, channel ASC`,
    [siteId, interval]
  );
  return result.rows;
}

// Contatti degli ultimi 7 giorni (indicatore freschezza, indipendente dal range).
async function kpiNewLeads7d(siteId) {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM contacts
     WHERE site_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
    [siteId]
  );
  return result.rows[0].count;
}

// Valore pipeline: somma pesata importo × probabilità sulle open.
async function kpiPipelineValue(siteId) {
  const result = await query(
    `SELECT COALESCE(SUM(amount * probability / 100.0), 0)::float AS value
     FROM opportunities WHERE site_id = $1 AND status = 'open'`,
    [siteId]
  );
  return result.rows[0].value;
}

async function kpiOpenOpportunities(siteId) {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM opportunities
     WHERE site_id = $1 AND status = 'open'`,
    [siteId]
  );
  return result.rows[0].count;
}

// Win rate: vinti / (vinti + persi), percentuale con un decimale.
async function kpiWinRate(siteId) {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'won')::int AS won,
       COUNT(*) FILTER (WHERE status = 'lost')::int AS lost
     FROM opportunities WHERE site_id = $1 AND status IN ('won', 'lost')`,
    [siteId]
  );
  const { won, lost } = result.rows[0];
  const total = won + lost;
  return total > 0 ? Math.round((won / total) * 1000) / 10 : 0;
}

// SLA task: aperte e aperte in ritardo (due_at nel passato).
async function kpiTasks(siteId) {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open')::int AS open,
       COUNT(*) FILTER (WHERE status = 'open' AND due_at IS NOT NULL AND due_at < NOW())::int AS overdue
     FROM tasks WHERE site_id = $1`,
    [siteId]
  );
  return result.rows[0];
}

async function kpiConversationsOpen(siteId) {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM conversations
     WHERE site_id = $1 AND status IN ('open', 'pending')`,
    [siteId]
  );
  return result.rows[0].count;
}

// Stats email da newsletter_sends (sent/opened). newsletter_sends non ha
// site_id: si risale al sito via newsletter_campaigns. Se lo schema cambia
// la query fallisce → try/catch e si ritorna {} (KPI non bloccante).
async function kpiEmailStats(siteId) {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS sent, COUNT(opened_at)::int AS opened
       FROM newsletter_sends s
       JOIN newsletter_campaigns c ON c.id = s.campaign_id
       WHERE c.site_id = $1`,
      [siteId]
    );
    return result.rows[0];
  } catch {
    return {};
  }
}

// Attività recente: ultimi 20 eventi del sito.
async function kpiRecentActivity(siteId) {
  const result = await query(
    `SELECT event_type, email, created_at FROM contact_events
     WHERE site_id = $1 ORDER BY id DESC LIMIT 20`,
    [siteId]
  );
  return result.rows;
}

export async function getKpis(siteId, { range = DEFAULT_RANGE } = {}) {
  const r = RANGES.includes(range) ? range : DEFAULT_RANGE;
  const interval = INTERVALS[r];

  const [
    leads,
    leadsByChannel,
    newLeads7d,
    pipelineValue,
    openOpportunities,
    winRate,
    tasks,
    conversationsOpen,
    emailStats,
    recentActivity,
  ] = await Promise.all([
    kpiLeads(siteId, interval),
    kpiLeadsByChannel(siteId, interval),
    kpiNewLeads7d(siteId),
    kpiPipelineValue(siteId),
    kpiOpenOpportunities(siteId),
    kpiWinRate(siteId),
    kpiTasks(siteId),
    kpiConversationsOpen(siteId),
    kpiEmailStats(siteId),
    kpiRecentActivity(siteId),
  ]);

  return {
    range: r,
    generated_at: new Date().toISOString(),
    leads,
    leads_by_channel: leadsByChannel,
    new_leads_7d: newLeads7d,
    pipeline_value: pipelineValue,
    open_opportunities: openOpportunities,
    win_rate: winRate,
    tasks_open: tasks.open,
    tasks_overdue: tasks.overdue,
    conversations_open: conversationsOpen,
    email_stats: emailStats,
    recent_activity: recentActivity,
  };
}

// ── Viste salvabili (CRUD) ──────────────────────────────────────────────

export async function listViews(siteId) {
  return (await query(
    `SELECT id, name, config, created_by, created_at, updated_at
     FROM dashboard_views WHERE site_id = $1 ORDER BY name`,
    [siteId]
  )).rows;
}

export async function createView(siteId, { name, config, createdBy = null } = {}) {
  const cleanName = String(name || "").trim().slice(0, 255);
  if (!cleanName) {
    throw Object.assign(new Error("Nome obbligatorio"), { status: 400 });
  }
  const result = await query(
    `INSERT INTO dashboard_views (site_id, name, config, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, config, created_by, created_at, updated_at`,
    [siteId, cleanName, JSON.stringify(sanitizeViewConfig(config)), createdBy]
  );
  return result.rows[0];
}

export async function updateView(siteId, id, data = {}) {
  const current = (await query(
    "SELECT * FROM dashboard_views WHERE id = $1 AND site_id = $2",
    [id, siteId]
  )).rows[0];
  if (!current) return null;

  const name = data.name !== undefined ? String(data.name).trim().slice(0, 255) : current.name;
  if (!name) {
    throw Object.assign(new Error("Nome obbligatorio"), { status: 400 });
  }
  const config = data.config !== undefined ? sanitizeViewConfig(data.config) : current.config;

  const result = await query(
    `UPDATE dashboard_views SET name = $1, config = $2, updated_at = NOW()
     WHERE id = $3 AND site_id = $4
     RETURNING id, name, config, created_by, created_at, updated_at`,
    [name, JSON.stringify(config), id, siteId]
  );
  return result.rows[0];
}

export async function deleteView(siteId, id) {
  const result = await query(
    "DELETE FROM dashboard_views WHERE id = $1 AND site_id = $2 RETURNING id",
    [id, siteId]
  );
  return result.rows[0] || null;
}
