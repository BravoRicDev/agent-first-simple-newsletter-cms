import { structuredPatch } from "diff";
import { query, getClient } from "../db.js";
import { normalizeUrlPath } from "./urls.js";

export const MAX_VERSIONS = 50;
const CORE = ["url_path", "title", "content", "layout_mode", "published"];
const ANCILLARY = ["post_type", "category_id", "excerpt", "featured_image", "published_at", "card_title", "reading_time_minutes", "card_html_override"];
const OPERATIONAL = ["publish_at", "unpublish_at", "author_id"]; // shown in diffs, never restored

function err(code, message) { const e = new Error(message || code); e.code = code; return e; }

// Snapshot COMPLETO della riga corrente della pagina. client opzionale (transazione).
export async function snapshotPage(pageId, userId, { source = "agent", label = null, client = null } = {}) {
  const q = client ? client.query.bind(client) : query;
  const ins = await q(
    `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published, post_type, category_id,
        excerpt, featured_image, published_at, publish_at, unpublish_at, card_title, reading_time_minutes, card_html_override,
        author_id, source, label)
     SELECT id, $2, url_path, title, content, layout_mode, published, post_type, category_id, excerpt, featured_image, published_at,
        publish_at, unpublish_at, card_title, reading_time_minutes, card_html_override, author_id, $3, $4
     FROM pages WHERE id = $1 RETURNING id, created_at`,
    [pageId, userId ?? null, source, label ? String(label).slice(0, 255) : null]
  );
  // Potatura SOLO dei nuovi snapshot (source NOT NULL): la storia legacy (righe strette senza source) non viene mai cancellata.
  await q(
    `DELETE FROM page_versions WHERE id IN (
       SELECT id FROM page_versions WHERE page_id = $1 AND source IS NOT NULL ORDER BY created_at DESC, id DESC OFFSET $2)`,
    [pageId, MAX_VERSIONS]
  );
  return ins.rows[0] || null;
}

// Una versione con content, troncato a maxChars (default 200000). truncated=true se tagliato.
export async function getVersion(pageId, versionId, { maxChars = 200000 } = {}) {
  const row = (await query(
    `SELECT pv.*, u.email AS user_email FROM page_versions pv LEFT JOIN users u ON u.id = pv.user_id
     WHERE pv.id = $1 AND pv.page_id = $2`, [versionId, pageId])).rows[0];
  if (!row) return null;
  const cap = Math.max(1000, Math.min(Number(maxChars) || 200000, 1000000));
  const truncated = (row.content || "").length > cap;
  return { ...row, content: truncated ? row.content.slice(0, cap) : row.content, content_length: (row.content || "").length, truncated };
}

function fieldsFor(row, isCurrent) {
  const full = isCurrent || row.source != null;
  return full ? [...CORE, ...ANCILLARY, ...OPERATIONAL] : [...CORE];
}
const short = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v).length > 300 ? String(v).slice(0, 300) + "..." : v);
const same = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a ?? 0).getTime() === new Date(b ?? 0).getTime() : (a ?? null) === (b ?? null));

// ref: numero (id versione) oppure "current". Ritorna diff bounded.
export async function diffVersions(siteId, pageId, fromRef, toRef, { context = 3, maxChars = 20000 } = {}) {
  const page = (await query("SELECT * FROM pages WHERE id = $1 AND site_id = $2", [pageId, siteId])).rows[0];
  if (!page) throw err("PAGE_NOT_FOUND");
  async function load(ref) {
    if (ref === "current") return { row: page, isCurrent: true, id: "current", at: page.updated_at };
    const id = parseInt(ref, 10);
    if (!Number.isInteger(id) || id < 1) throw err("VERSION_NOT_FOUND");
    const v = (await query("SELECT * FROM page_versions WHERE id = $1 AND page_id = $2", [id, pageId])).rows[0];
    if (!v) throw err("VERSION_NOT_FOUND");
    return { row: v, isCurrent: false, id, at: v.created_at };
  }
  const a = await load(fromRef);
  const b = await load(toRef);
  const common = fieldsFor(a.row, a.isCurrent).filter((f) => fieldsFor(b.row, b.isCurrent).includes(f));
  const changed_fields = common.filter((f) => f !== "content" && !same(a.row[f], b.row[f]))
    .map((f) => ({ field: f, from: short(a.row[f]), to: short(b.row[f]) }));
  // structuredPatch e' SINCRONO: su due testi molto diversi blocca l'event loop (misurato 14 s su 8000 righe). timeout => undefined.
  const patch = structuredPatch("from", "to", a.row.content || "", b.row.content || "", "", "", { context: Math.max(0, Math.min(Number(context) || 3, 20)), timeout: 1500 });
  const tooLarge = !patch;
  let added = 0, removed = 0, used = 0, truncated = false;
  const hunks = [];
  for (const h of (patch ? patch.hunks : [])) {
    for (const l of h.lines) { if (l[0] === "+") added++; else if (l[0] === "-") removed++; }
    if (truncated) continue;
    const size = h.lines.reduce((n, l) => n + l.length + 1, 0);
    if (used + size > maxChars) { truncated = true; continue; }
    used += size;
    hunks.push({ old_start: h.oldStart, old_lines: h.oldLines, new_start: h.newStart, new_lines: h.newLines, lines: h.lines.filter((l) => l[0] !== "\\") });
  }
  return {
    page_id: pageId,
    from: { id: a.id, at: a.at }, to: { id: b.id, at: b.at },
    legacy_version_limited_to_core_fields: [a, b].some((x) => !x.isCurrent && x.row.source == null),
    changed_fields,
    content: { identical: tooLarge ? (a.row.content || "") === (b.row.content || "") : added === 0 && removed === 0, added_lines: tooLarge ? null : added, removed_lines: tooLarge ? null : removed, hunks, truncated: truncated || tooLarge, ...(tooLarge ? { too_large_to_diff: true } : {}) },
  };
}

// Restore completo in transazione. Ritorna { page, restored_version_id, snapshot_id, oldUrlPath, touchedArticle }.
export async function restoreVersion(siteId, pageId, versionId, userId, { source = "agent", expectedUpdatedAt = null } = {}) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const page = (await client.query("SELECT * FROM pages WHERE id = $1 AND site_id = $2 FOR UPDATE", [pageId, siteId])).rows[0];
    if (!page) throw err("PAGE_NOT_FOUND");
    if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== new Date(page.updated_at).getTime()) throw err("STALE");
    const v = (await client.query("SELECT * FROM page_versions WHERE id = $1 AND page_id = $2", [versionId, pageId])).rows[0];
    if (!v) throw err("VERSION_NOT_FOUND");
    const snap = await snapshotPage(pageId, userId, { source, label: `before-restore-${versionId}`, client });
    const safeUrl = normalizeUrlPath(v.url_path); // blocca path traversal anche su dati legacy
    const full = v.source != null;
    const cat = full && v.category_id
      ? (await client.query("SELECT id FROM categories WHERE id = $1 AND site_id = $2", [v.category_id, siteId])).rows[0]?.id ?? null
      : page.category_id;
    const upd = await client.query(
      `UPDATE pages SET url_path = $3, title = $4, content = $5, layout_mode = $6, published = $7,
         post_type = $8, category_id = $9, excerpt = $10, featured_image = $11, published_at = $12,
         card_title = $13, reading_time_minutes = $14, card_html_override = $15, updated_at = NOW()
       WHERE id = $1 AND site_id = $2 RETURNING *`,
      [pageId, siteId, safeUrl, v.title, v.content, v.layout_mode, v.published,
       full ? v.post_type : page.post_type, cat, full ? v.excerpt : page.excerpt,
       full ? v.featured_image : page.featured_image, full ? v.published_at : page.published_at,
       full ? v.card_title : page.card_title, full ? v.reading_time_minutes : page.reading_time_minutes,
       full ? v.card_html_override : page.card_html_override]
    );
    await client.query("COMMIT");
    const np = upd.rows[0];
    return { page: np, restored_version_id: v.id, snapshot_id: snap?.id ?? null, oldUrlPath: page.url_path,
             touchedArticle: np.post_type === "article" || page.post_type === "article" };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function restoreLastVersion(siteId, pageId, userId, opts = {}) {
  const last = (await query(
    "SELECT pv.id, pv.created_at FROM page_versions pv JOIN pages p ON p.id = pv.page_id WHERE pv.page_id = $1 AND p.site_id = $2 ORDER BY pv.created_at DESC, pv.id DESC LIMIT 1",
    [pageId, siteId])).rows[0];
  if (!last) throw err("NO_VERSIONS");
  const out = await restoreVersion(siteId, pageId, last.id, userId, opts);
  return { ...out, restored_at: last.created_at };
}

// Mappa errori del servizio -> { status, body } (null se non riconosciuto).
export function mapVersionError(e, t) {
  if (e?.code === "PAGE_NOT_FOUND") return { status: 404, body: { error: t("api.pages.notFound") } };
  if (e?.code === "VERSION_NOT_FOUND") return { status: 404, body: { error: t("api.pages.versionNotFound") } };
  if (e?.code === "NO_VERSIONS") return { status: 400, body: { error: t("api.pages.noPreviousVersion") } };
  if (e?.code === "STALE") return { status: 409, body: { error: "stale_page", code: "stale_page" } };
  if (e?.code === "23505") return { status: 409, body: { error: t("api.pages.urlExists") } };
  if (e?.message === "URL non valido") return { status: 400, body: { error: t("api.common.invalidUrl") } };
  return null;
}
