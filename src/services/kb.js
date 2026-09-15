import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Knowledge base aziendale (F30): listini, FAQ, procedure.
// Articoli per sito con titolo, contenuto, categoria e tag; ricerca
// full-text italiana (tsvector GIN) con fallback LIKE su input strani.
// ─────────────────────────────────────────────────────────────────────────

const MAX_TITLE = 255;
const MAX_CONTENT = 100000;
const MAX_CATEGORY = 100;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 100;

// tags: array di stringhe, al massimo MAX_TAGS elementi (gli altri scartati),
// ogni tag trimmato e limitato in lunghezza.
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const cleaned = [];
  for (const t of tags) {
    if (cleaned.length >= MAX_TAGS) break;
    const tag = String(t ?? "").trim().slice(0, MAX_TAG_LEN);
    if (tag) cleaned.push(tag);
  }
  return cleaned;
}

const TS_EXPR = "to_tsvector('italian', coalesce(title,'') || ' ' || coalesce(content,''))";

export async function listArticles(siteId, { category = null, limit = 50, offset = 0 } = {}) {
  const params = [parseInt(siteId, 10)];
  let where = "site_id = $1";
  if (category) {
    params.push(String(category).trim().slice(0, MAX_CATEGORY));
    where += ` AND category = $${params.length}`;
  }
  params.push(
    Math.min(parseInt(limit, 10) || 50, 500),
    Math.max(parseInt(offset, 10) || 0, 0)
  );
  return (await query(
    `SELECT * FROM kb_articles WHERE ${where}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )).rows;
}

export async function getArticle(siteId, articleId) {
  const row = (await query(
    "SELECT * FROM kb_articles WHERE id = $1 AND site_id = $2",
    [parseInt(articleId, 10), parseInt(siteId, 10)]
  )).rows[0];
  return row || null;
}

export async function createArticle(siteId, { title, content = "", category = "", tags = [] } = {}) {
  const result = await query(
    `INSERT INTO kb_articles (site_id, title, content, category, tags)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      parseInt(siteId, 10),
      String(title || "").trim().slice(0, MAX_TITLE),
      String(content || "").slice(0, MAX_CONTENT),
      String(category || "").trim().slice(0, MAX_CATEGORY),
      JSON.stringify(sanitizeTags(tags)),
    ]
  );
  return result.rows[0];
}

export async function updateArticle(siteId, articleId, data = {}) {
  const current = await getArticle(siteId, articleId);
  if (!current) return null;
  const result = await query(
    `UPDATE kb_articles
     SET title = $1, content = $2, category = $3, tags = $4, updated_at = NOW()
     WHERE id = $5 AND site_id = $6 RETURNING *`,
    [
      data.title !== undefined ? String(data.title).trim().slice(0, MAX_TITLE) : current.title,
      data.content !== undefined ? String(data.content).slice(0, MAX_CONTENT) : current.content,
      data.category !== undefined ? String(data.category).trim().slice(0, MAX_CATEGORY) : current.category,
      JSON.stringify(data.tags !== undefined ? sanitizeTags(data.tags) : (current.tags ?? [])),
      parseInt(articleId, 10),
      parseInt(siteId, 10),
    ]
  );
  return result.rows[0];
}

export async function deleteArticle(siteId, articleId) {
  const result = await query(
    "DELETE FROM kb_articles WHERE id = $1 AND site_id = $2",
    [parseInt(articleId, 10), parseInt(siteId, 10)]
  );
  return result.rowCount > 0;
}

// Ricerca full-text italiana su titolo + contenuto. plainto_tsquery può
// fallire su input strani (es. stringhe troppo lunghe): in quel caso si
// ripiega su una ricerca LIKE case-insensitive.
export async function searchKb(siteId, q, { category = null, limit = 10 } = {}) {
  const searchQ = String(q || "").trim();
  if (!searchQ) return [];
  const max = Math.min(parseInt(limit, 10) || 10, 100);
  const sid = parseInt(siteId, 10);

  try {
    const params = [sid, searchQ];
    let where = `site_id = $1 AND ${TS_EXPR} @@ plainto_tsquery('italian', $2)`;
    if (category) {
      params.push(String(category).trim().slice(0, MAX_CATEGORY));
      where += ` AND category = $${params.length}`;
    }
    params.push(max);
    return (await query(
      `SELECT id, title, category, tags,
              ts_rank(${TS_EXPR}, plainto_tsquery('italian', $2)) AS rank,
              LEFT(content, 300) AS snippet
       FROM kb_articles WHERE ${where}
       ORDER BY rank DESC, id DESC
       LIMIT $${params.length}`,
      params
    )).rows;
  } catch {
    const params = [sid, `%${searchQ}%`];
    let where = "site_id = $1 AND (title ILIKE $2 OR content ILIKE $2)";
    if (category) {
      params.push(String(category).trim().slice(0, MAX_CATEGORY));
      where += ` AND category = $${params.length}`;
    }
    params.push(max);
    return (await query(
      `SELECT id, title, category, tags, 0 AS rank, LEFT(content, 300) AS snippet
       FROM kb_articles WHERE ${where}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    )).rows;
  }
}
