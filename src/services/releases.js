import { query, getClient } from "../db.js";
import { auditLog } from "./audit.js";
import { snapshotPage } from "./page-versions.js";
import { afterContentChange } from "./site-sync.js";
import { isWorkflowEnabled, canPublish } from "./editorial.js";
import { logger } from "./logger.js";

const MAX_ITEMS = 200;
const ACTIONS = ["publish", "unpublish"];
function err(code, extra = {}) { const e = new Error(code); e.code = code; Object.assign(e, extra); return e; }
const uid = (user) => (user ? (user.id ?? user.sub ?? null) : null);

async function loadRelease(siteId, id) {
  const r = (await query("SELECT * FROM releases WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
  if (!r) throw err("RELEASE_NOT_FOUND");
  return r;
}

export async function createRelease(siteId, { name, description = "" } = {}, user = null) {
  const n = String(name ?? "").trim();
  if (!n || n.length > 200) throw err("INVALID_NAME");
  const r = (await query(
    "INSERT INTO releases (site_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
    [siteId, n, String(description ?? "").slice(0, 5000), uid(user)])).rows[0];
  await auditLog({ userId: uid(user), siteId, entityType: "release", entityId: r.id, action: "release_create", newData: { name: n }, ipAddress: null });
  return r;
}

export async function listReleases(siteId, { status = null, limit = 50, offset = 0 } = {}) {
  const params = [siteId];
  let where = "r.site_id = $1";
  if (status) { params.push(String(status)); where += ` AND r.status = $${params.length}`; }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0));
  return (await query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM release_items ri WHERE ri.release_id = r.id) AS item_count
     FROM releases r WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
}

export async function getRelease(siteId, id) {
  const release = await loadRelease(siteId, id);
  const items = (await query(
    `SELECT ri.page_id, ri.action, ri.base_updated_at, ri.position, p.url_path, p.title, p.published, p.editorial_status, p.post_type, p.updated_at
     FROM release_items ri JOIN pages p ON p.id = ri.page_id WHERE ri.release_id = $1 ORDER BY ri.position, ri.page_id`, [id])).rows;
  return { release, items };
}

export async function updateRelease(siteId, id, { name, description } = {}) {
  const rel = await loadRelease(siteId, id);
  if (!["draft", "scheduled"].includes(rel.status)) throw err("INVALID_STATE");
  const n = name === undefined ? rel.name : String(name).trim();
  if (!n || n.length > 200) throw err("INVALID_NAME");
  const d = description === undefined ? rel.description : String(description).slice(0, 5000);
  return (await query("UPDATE releases SET name = $2, description = $3, updated_at = NOW() WHERE id = $1 RETURNING *", [id, n, d])).rows[0];
}

export async function deleteRelease(siteId, id) {
  const rel = await loadRelease(siteId, id);
  if (!["draft", "cancelled", "failed"].includes(rel.status)) throw err("INVALID_STATE");
  await query("DELETE FROM releases WHERE id = $1", [id]);
  return { deleted: true };
}

export async function addItems(siteId, id, items, user = null) {
  const rel = await loadRelease(siteId, id);
  if (!["draft", "scheduled"].includes(rel.status)) throw err("INVALID_STATE");
  if (!Array.isArray(items) || items.length === 0) throw err("INVALID_ACTION");
  for (const it of items) {
    if (!it || !ACTIONS.includes(it.action) || !Number.isInteger(Number(it.page_id)) || Number(it.page_id) < 1) throw err("INVALID_ACTION");
  }
  const pageIds = [...new Set(items.map((i) => Number(i.page_id)))];
  const okIds = (await query("SELECT id FROM pages WHERE site_id = $1 AND managed_by IS NULL AND id = ANY($2::int[])", [siteId, pageIds])).rows.map((r) => r.id);
  const bad = pageIds.filter((p) => !okIds.includes(p));
  if (bad.length) throw err("PAGE_NOT_IN_SITE", { page_ids: bad });
  const existing = (await query("SELECT page_id FROM release_items WHERE release_id = $1", [id])).rows.map((r) => r.page_id);
  if (new Set([...existing, ...pageIds]).size > MAX_ITEMS) throw err("TOO_MANY_ITEMS");
  let pos = existing.length;
  for (const it of items) {
    await query(
      `INSERT INTO release_items (release_id, page_id, action, base_updated_at, position)
       SELECT $1, p.id, $3, p.updated_at, $4 FROM pages p WHERE p.id = $2 AND p.site_id = $5
       ON CONFLICT (release_id, page_id) DO UPDATE SET action = EXCLUDED.action, base_updated_at = EXCLUDED.base_updated_at`,
      [id, Number(it.page_id), it.action, pos++, siteId]);
  }
  await query("UPDATE releases SET updated_at = NOW() WHERE id = $1", [id]);
  return getRelease(siteId, id);
}

export async function removeItem(siteId, id, pageId) {
  const rel = await loadRelease(siteId, id);
  if (!["draft", "scheduled"].includes(rel.status)) throw err("INVALID_STATE");
  await query("DELETE FROM release_items WHERE release_id = $1 AND page_id = $2", [id, pageId]);
  await query("UPDATE releases SET updated_at = NOW() WHERE id = $1", [id]);
  return { ok: true };
}

const itemsSql = (lock) => `
  SELECT ri.page_id, ri.action, p.url_path, p.title, p.post_type, p.published, p.editorial_status,
         (p.updated_at > ri.base_updated_at) AS page_changed
  FROM release_items ri JOIN pages p ON p.id = ri.page_id
  WHERE ri.release_id = $1 ORDER BY ri.position, ri.page_id ${lock ? "FOR UPDATE OF p" : ""}`;

function evalRow(r, workflowOn) {
  const target = r.action === "publish";
  const willChange = r.published !== target;
  const conflicts = [];
  if (willChange && r.page_changed) conflicts.push("page_changed");
  if (willChange && target && workflowOn && !["approved", "published"].includes(r.editorial_status || "")) conflicts.push("not_approved");
  return { page_id: r.page_id, url_path: r.url_path, title: r.title, post_type: r.post_type, action: r.action,
    current_published: r.published, target_published: target, will_change: willChange, conflicts };
}
const summarize = (items) => ({
  total: items.length, will_change: items.filter((i) => i.will_change).length,
  no_op: items.filter((i) => !i.will_change).length, conflicts: items.filter((i) => i.conflicts.length).length,
});

// Dry run: nessuna scrittura.
export async function previewRelease(siteId, id) {
  const release = await loadRelease(siteId, id);
  const workflowOn = await isWorkflowEnabled(siteId);
  const items = (await query(itemsSql(false), [id])).rows.map((r) => evalRow(r, workflowOn));
  return { release, items, summary: summarize(items) };
}

export async function scheduleRelease(siteId, id, when, user) {
  if (!(await canPublish(user, siteId))) throw err("FORBIDDEN");
  const rel = await loadRelease(siteId, id);
  if (!["draft", "scheduled"].includes(rel.status)) throw err("INVALID_STATE");
  const n = (await query("SELECT COUNT(*)::int AS n FROM release_items WHERE release_id = $1", [id])).rows[0].n;
  if (n < 1) throw err("NO_ITEMS");
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw err("SCHEDULE_PAST");
  const release = (await query("UPDATE releases SET status = 'scheduled', scheduled_at = $2, error = NULL, updated_at = NOW() WHERE id = $1 RETURNING *", [id, d])).rows[0];
  await auditLog({ userId: uid(user), siteId, entityType: "release", entityId: id, action: "release_schedule", newData: { scheduled_at: d.toISOString() }, ipAddress: null });
  return { release, preview: (await previewRelease(siteId, id)).summary };
}

export async function cancelRelease(siteId, id, user) {
  const rel = await loadRelease(siteId, id);
  if (!["draft", "scheduled"].includes(rel.status)) throw err("INVALID_STATE");
  const isCreator = rel.created_by != null && rel.created_by === uid(user);
  if (!isCreator && !(await canPublish(user, siteId))) throw err("FORBIDDEN");
  const release = (await query("UPDATE releases SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status IN ('draft','scheduled') RETURNING *", [id])).rows[0];
  if (!release) throw err("INVALID_STATE");
  await auditLog({ userId: uid(user), siteId, entityType: "release", entityId: id, action: "release_cancel", ipAddress: null });
  return release;
}

// Accetta lo stato attuale delle pagine: neutralizza il controllo conflitti => richiede diritti di pubblicazione.
export async function rebaseRelease(siteId, id, user) {
  if (!(await canPublish(user, siteId))) throw err("FORBIDDEN");
  const rel = await loadRelease(siteId, id);
  if (!["draft", "scheduled", "failed"].includes(rel.status)) throw err("INVALID_STATE");
  await query("UPDATE release_items ri SET base_updated_at = p.updated_at FROM pages p WHERE p.id = ri.page_id AND ri.release_id = $1", [id]);
  if (rel.status === "failed") await query("UPDATE releases SET status = 'draft', error = NULL, result = NULL, updated_at = NOW() WHERE id = $1", [id]);
  return { ok: true };
}

const PUBLISH_SQL = `UPDATE pages SET published = true, publish_at = NULL,
  published_at = CASE WHEN post_type = 'article' THEN COALESCE(published_at, NOW()) ELSE published_at END,
  unpublish_at = CASE WHEN unpublish_at IS NOT NULL AND unpublish_at <= NOW() THEN NULL ELSE unpublish_at END,
  editorial_status = CASE WHEN editorial_status = 'approved' THEN 'published' ELSE editorial_status END, updated_at = NOW() WHERE id = $1`;
const UNPUBLISH_SQL = `UPDATE pages SET published = false, unpublish_at = NULL,
  editorial_status = CASE WHEN editorial_status = 'published' THEN 'draft' ELSE editorial_status END, updated_at = NOW() WHERE id = $1`;

// Esecuzione atomica. source: "scheduler" (solo status scheduled) | "manual" (scheduled o draft, richiede canPublish).
// Ritorna { skipped:true } | { ok:false, conflicts } | { ok:false, error } | { ok:true, changed, no_op }. Con source manual le eccezioni vengono rilanciate.
export async function executeRelease(releaseId, { force = false, user = null, source = "scheduler" } = {}) {
  const manual = source === "manual";
  const pre = (await query("SELECT * FROM releases WHERE id = $1", [releaseId])).rows[0];
  if (!pre) return { skipped: true };
  if (manual && !(await canPublish(user, pre.site_id))) throw err("FORBIDDEN");
  const siteId = pre.site_id;
  const workflowOn = await isWorkflowEnabled(siteId);
  const allowedStatuses = manual ? ["scheduled", "draft"] : ["scheduled"];
  const userId = uid(user);
  const client = await getClient();
  let outcome = null;
  try {
    await client.query("BEGIN");
    const claimed = (await client.query("UPDATE releases SET status = 'running', updated_at = NOW() WHERE id = $1 AND status = ANY($2::text[]) RETURNING id", [releaseId, allowedStatuses])).rows[0];
    if (!claimed) { await client.query("ROLLBACK"); return { skipped: true }; }
    const items = (await client.query(itemsSql(true), [releaseId])).rows.map((r) => evalRow(r, workflowOn));
    const blocking = items.filter((i) => i.conflicts.some((c) => c === "not_approved" || (c === "page_changed" && !force)));
    if (blocking.length) {
      const result = { conflicts: blocking.map((i) => ({ page_id: i.page_id, url_path: i.url_path, conflicts: i.conflicts })) };
      await client.query("UPDATE releases SET status = 'failed', error = 'conflicts', result = $2, executed_at = NOW(), updated_at = NOW() WHERE id = $1", [releaseId, JSON.stringify(result)]);
      await client.query("COMMIT");
      outcome = { failed: result };
    } else {
      const changed = [];
      for (const it of items) {
        if (!it.will_change) continue;
        await snapshotPage(it.page_id, userId, { source: "release", label: `release-${releaseId}`, client });
        await client.query(it.action === "publish" ? PUBLISH_SQL : UNPUBLISH_SQL, [it.page_id]);
        changed.push(it);
      }
      const result = { changed: changed.length, no_op: items.length - changed.length, pages: changed.map((i) => ({ page_id: i.page_id, url_path: i.url_path, action: i.action })) };
      await client.query("UPDATE releases SET status = 'done', executed_at = NOW(), error = NULL, result = $2, updated_at = NOW() WHERE id = $1", [releaseId, JSON.stringify(result)]);
      await client.query("COMMIT");
      outcome = { done: result, changed };
    }
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    // il ROLLBACK annulla anche il claim: la riga e' tornata scheduled/draft => va marcata failed, altrimenti lo scheduler la ritenterebbe per sempre.
    await query("UPDATE releases SET status = 'failed', error = $2, executed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status IN ('scheduled','draft','running')", [releaseId, String(e.message).slice(0, 500)]).catch(() => {});
    await auditLog({ userId, siteId, entityType: "release", entityId: releaseId, action: "release_failed", newData: { error: String(e.message).slice(0, 200) }, ipAddress: null });
    logger.error(`release ${releaseId} failed: ${e.message}`);
    if (manual) throw e;
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }

  if (outcome.failed) {
    await auditLog({ userId, siteId, entityType: "release", entityId: releaseId, action: "release_failed", newData: { error: "conflicts", count: outcome.failed.conflicts.length }, ipAddress: null });
    return { ok: false, conflicts: outcome.failed.conflicts };
  }
  const { done, changed } = outcome;
  await auditLog({ userId, siteId, entityType: "release", entityId: releaseId, action: "release_execute", newData: { ...done, source }, ipAddress: null });
  for (const p of done.pages) {
    await auditLog({ userId, siteId, entityType: "page", entityId: p.page_id, action: p.action, newData: { url_path: p.url_path, source: "release", release_id: releaseId }, ipAddress: null });
  }
  if (changed.length > 0) {
    const run = afterContentChange(siteId, {
      articleChanged: changed.some((i) => i.post_type === "article"),
      deleteStaticPaths: changed.filter((i) => i.action === "unpublish").map((i) => i.url_path),
      awaitExport: source === "scheduler",
    }).catch((e) => logger.error(`release ${releaseId} sync: ${e.message}`));
    if (source === "scheduler") await run;
  }
  return { ok: true, changed: done.changed, no_op: done.no_op };
}

export function mapReleaseError(e, t) {
  const table = { RELEASE_NOT_FOUND: 404, INVALID_STATE: 409, NO_ITEMS: 400, SCHEDULE_PAST: 400, FORBIDDEN: 403, PAGE_NOT_IN_SITE: 400, TOO_MANY_ITEMS: 400, INVALID_ACTION: 400, INVALID_NAME: 400 };
  const status = table[e?.code];
  if (!status) return null;
  const key = e.code.toLowerCase();
  return { status, body: { error: key, code: key, message: t(`api.releases.${key}`), ...(e.page_ids ? { page_ids: e.page_ids } : {}) } };
}
