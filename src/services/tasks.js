import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Task vendite + funnel snapshot.
// ─────────────────────────────────────────────────────────────────────────

export async function listTasks(siteId, { assigneeId = null, status = null, email = null, limit = 100, offset = 0 } = {}) {
  const params = [siteId];
  let where = "t.site_id = $1";
  if (assigneeId) {
    params.push(parseInt(assigneeId, 10));
    where += ` AND t.assignee_id = $${params.length}`;
  }
  if (status && ["open", "done", "cancelled"].includes(status)) {
    params.push(status);
    where += ` AND t.status = $${params.length}`;
  }
  if (email) {
    params.push(String(email).trim().toLowerCase());
    where += ` AND t.email = $${params.length}`;
  }
  params.push(Math.min(parseInt(limit, 10) || 100, 500), Math.max(parseInt(offset, 10) || 0, 0));
  const rows = (await query(
    `SELECT t.*, u.email AS assignee_email, u.name AS assignee_name
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE ${where} ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )).rows;
  return rows;
}

export async function getTask(siteId, taskId) {
  const row = (await query(
    `SELECT t.*, u.email AS assignee_email, u.name AS assignee_name
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.id = $1 AND t.site_id = $2`,
    [taskId, siteId]
  )).rows[0];
  return row || null;
}

export async function createTask(siteId, { title, email = "", assigneeId = null, dueAt = null, notes = "", createdBy = null }) {
  const result = await query(
    `INSERT INTO tasks (site_id, email, assignee_id, title, notes, due_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      siteId,
      String(email || "").trim().toLowerCase().slice(0, 255),
      assigneeId ? parseInt(assigneeId, 10) : null,
      String(title || "").trim().slice(0, 255),
      String(notes || "").slice(0, 2000),
      dueAt ? new Date(dueAt) : null,
      createdBy || null,
    ]
  );
  return result.rows[0];
}

export async function updateTask(siteId, taskId, { title, email, assigneeId, dueAt, notes, status }) {
  const current = await getTask(siteId, taskId);
  if (!current) return null;
  const nextStatus = status !== undefined ? (["open", "done", "cancelled"].includes(status) ? status : current.status) : current.status;
  const wasDone = current.status === "done";
  const next = {
    title: title !== undefined ? String(title).trim().slice(0, 255) : current.title,
    email: email !== undefined ? String(email).trim().toLowerCase().slice(0, 255) : current.email,
    assignee_id: assigneeId !== undefined ? (assigneeId ? parseInt(assigneeId, 10) : null) : current.assignee_id,
    due_at: dueAt !== undefined ? (dueAt ? new Date(dueAt) : null) : current.due_at,
    notes: notes !== undefined ? String(notes).slice(0, 2000) : current.notes,
    status: nextStatus,
  };
  const result = await query(
    `UPDATE tasks SET title = $1, email = $2, assignee_id = $3, due_at = $4, notes = $5,
       status = $6, done_at = $7
     WHERE id = $8 AND site_id = $9 RETURNING *`,
    [next.title, next.email, next.assignee_id, next.due_at, next.notes, next.status,
     (next.status === "done" && !wasDone) ? new Date() : current.done_at, taskId, siteId]
  );
  return result.rows[0];
}

export async function deleteTask(siteId, taskId) {
  await query("DELETE FROM tasks WHERE id = $1 AND site_id = $2", [taskId, siteId]);
}

// Snapshot giornaliero per canale: visite (page_views), lead
// (form_submissions del giorno), chiamate, vinti + revenue.
// Calcolato dal tick scheduler (buildFunnelSnapshots).
export async function buildFunnelSnapshot(siteId, day = null) {
  const targetDay = day || new Date().toISOString().slice(0, 10);

  // Visite: page_views ha visited_at e si collega al sito via page_id.
  const visitsRow = (await query(
    `SELECT COUNT(*) AS c FROM page_views pv
     JOIN pages p ON p.id = pv.page_id
     WHERE p.site_id = $1 AND pv.visited_at::date = $2::date`,
    [siteId, targetDay]
  )).rows[0] || { c: 0 };

  const leadsRows = (await query(
    `SELECT COALESCE(NULLIF(data->>'utm_source',''), '') AS channel, COUNT(*) AS c
     FROM form_submissions WHERE site_id = $1 AND created_at::date = $2::date
     GROUP BY channel`,
    [siteId, targetDay]
  )).rows;

  // Chiamate: canale dal contatto (contacts.utm_source), join su email.
  const callsRows = (await query(
    `SELECT COALESCE(NULLIF(c2.utm_source,''), '') AS channel, COUNT(*) AS c
     FROM calls c1
     LEFT JOIN contacts c2 ON c2.site_id = c1.site_id AND c2.email = c1.email
     WHERE c1.site_id = $1 AND c1.created_at::date = $2::date
     GROUP BY channel`,
    [siteId, targetDay]
  )).rows;

  const winsRows = (await query(
    `SELECT COALESCE(NULLIF(c.utm_source,''), '') AS channel, COUNT(*) AS c,
            COALESCE(SUM(c.value_estimate), 0) AS revenue
     FROM contacts c
     WHERE c.site_id = $1 AND c.status = 'vinto'
       AND c.updated_at::date = $2::date
     GROUP BY channel`,
    [siteId, targetDay]
  )).rows;

  const channels = new Set([
    ...leadsRows.map((r) => r.channel),
    ...callsRows.map((r) => r.channel),
    ...winsRows.map((r) => r.channel),
  ]);

  const totalLeads = leadsRows.reduce((s, r) => s + parseInt(r.c, 10), 0);

  // Riga per canale + riga totale (channel '').
  const entries = [];
  for (const channel of channels) {
    const lead = leadsRows.find((r) => r.channel === channel) || { c: 0 };
    const call = callsRows.find((r) => r.channel === channel) || { c: 0 };
    const win = winsRows.find((r) => r.channel === channel) || { c: 0, revenue: 0 };
    entries.push({
      channel,
      visits: parseInt(visitsRow.c, 10),
      leads: parseInt(lead.c, 10),
      calls: parseInt(call.c, 10),
      wins: parseInt(win.c, 10),
      revenue: Number(win.revenue) || 0,
    });
  }
  entries.push({
    channel: "",
    visits: parseInt(visitsRow.c, 10),
    leads: totalLeads,
    calls: callsRows.reduce((s, r) => s + parseInt(r.c, 10), 0),
    wins: winsRows.reduce((s, r) => s + parseInt(r.c, 10), 0),
    revenue: winsRows.reduce((s, r) => s + (Number(r.revenue) || 0), 0),
  });

  for (const e of entries) {
    await query(
      `INSERT INTO funnel_snapshots (site_id, day, channel, visits, leads, calls, wins, revenue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (site_id, day, channel) DO UPDATE SET
         visits = EXCLUDED.visits, leads = EXCLUDED.leads, calls = EXCLUDED.calls,
         wins = EXCLUDED.wins, revenue = EXCLUDED.revenue`,
      [siteId, targetDay, e.channel, e.visits, e.leads, e.calls, e.wins, e.revenue]
    );
  }
  return entries;
}

export async function buildFunnelSnapshotsForAllSites() {
  const sites = (await query("SELECT id FROM sites")).rows;
  for (const site of sites) {
    try {
      await buildFunnelSnapshot(site.id);
    } catch (err) {
      logger.error(`Funnel snapshot fallito per site ${site.id}: ${err.message}`);
    }
  }
}

export async function getFunnel(siteId, { from = null, to = null } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (from) {
    params.push(from);
    where += ` AND day >= $${params.length}::date`;
  }
  if (to) {
    params.push(to);
    where += ` AND day <= $${params.length}::date`;
  }
  const rows = (await query(
    `SELECT day, channel, visits, leads, calls, wins, revenue
     FROM funnel_snapshots WHERE ${where} ORDER BY day DESC, channel`,
    params
  )).rows;
  return rows;
}
