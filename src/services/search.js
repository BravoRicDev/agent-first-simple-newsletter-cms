import { query } from "../db.js";
import { getBlogSetting } from "./blog-settings.js";

export const SEARCH_LANGS = ["italian", "english", "simple"];
const SEL = "\u0001";
const STOP = "\u0002";
const escHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export async function getSearchLanguage(siteId) {
  const v = await getBlogSetting(siteId, "search_language");
  return SEARCH_LANGS.includes(v) ? v : "italian";
}

const PUBLIC_CONDS = `p.published = true AND (p.unpublish_at IS NULL OR p.unpublish_at > NOW()) AND p.managed_by IS NULL AND s.noindex IS NOT TRUE`;
const ADMIN_CONDS = `p.managed_by IS NULL`;

export async function searchPages(siteId, q, { limit = 10, offset = 0, includeUnpublished = false } = {}) {
  const term = String(q ?? "").trim().slice(0, 100);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const off = Math.min(Math.max(parseInt(offset, 10) || 0, 0), 1000);
  if (term.length < 2) return { results: [], total: 0, limit: lim, offset: off };
  const cfg = await getSearchLanguage(siteId);
  const conds = includeUnpublished ? ADMIN_CONDS : PUBLIC_CONDS;
  const opts = `StartSel=${SEL}, StopSel=${STOP}, MaxFragments=1, MaxWords=30, MinWords=12`;
  const rows = (await query(
    `WITH hits AS (
       SELECT p.id, ts_rank_cd(si.tsv, qq.tsq) AS rank, COUNT(*) OVER() AS total
       FROM pages p
       JOIN page_search_index si ON si.page_id = p.id
       LEFT JOIN page_seo s ON s.page_id = p.id,
            websearch_to_tsquery($2::regconfig, $3) AS qq(tsq)
       WHERE p.site_id = $1 AND si.tsv @@ qq.tsq AND ${conds}
       ORDER BY rank DESC, p.id
       LIMIT $4 OFFSET $5)
     SELECT h.id, h.rank, h.total, p.url_path, p.title, p.published, p.post_type,
            ts_headline($2::regconfig, left(pages_plain_text(p.content), 20000), websearch_to_tsquery($2::regconfig, $3), $6) AS snippet
     FROM hits h JOIN pages p ON p.id = h.id
     ORDER BY h.rank DESC, h.id`,
    [siteId, cfg, term, lim, off, opts])).rows;
  return {
    results: rows.map((r) => ({
      id: r.id, title: r.title, url: r.url_path, score: Number(r.rank),
      snippet: escHtml(r.snippet).replaceAll(SEL, "<mark>").replaceAll(STOP, "</mark>"),
      ...(includeUnpublished ? { published: r.published, post_type: r.post_type } : {}),
    })),
    total: rows.length ? parseInt(rows[0].total, 10) : 0,
    limit: lim, offset: off,
  };
}

// Ricalcola l'indice di tutto il sito (dopo il cambio di search_language o dopo modifiche SQL massive).
export async function reindexSite(siteId) {
  const r = await query(
    `INSERT INTO page_search_index (page_id, site_id, tsv)
     SELECT id, site_id, pages_build_tsv(site_id, title, excerpt, content) FROM pages WHERE site_id = $1
     ON CONFLICT (page_id) DO UPDATE SET site_id = EXCLUDED.site_id, tsv = EXCLUDED.tsv`, [siteId]);
  return r.rowCount;
}
