import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { query } from "../db.js";
import { getBlogConfig } from "./blog-settings.js";
import { deriveExcerptFromContent } from "./blog-index.js";

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function xmlText(s) {
  return String(s ?? "").replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function cdata(s) {
  return "<![CDATA[" + String(s ?? "").replace(INVALID_XML, "").replaceAll("]]>", "]]]]><![CDATA[>") + "]]>";
}
// src="/x" / href="/x" -> assoluti; "//host" (protocol-relative) NON viene toccato.
export function absolutizeHtml(html, baseUrl) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  return String(html ?? "").replace(/\b(src|href)=(["'])\/(?!\/)/gi, `$1=$2${base}/`);
}
export function feedPath(format, categorySlug = null) {
  if (!categorySlug) return format === "atom" ? "/atom.xml" : "/feed.xml";
  return format === "atom" ? `/feed/${categorySlug}.atom.xml` : `/feed/${categorySlug}.xml`;
}

export async function getFeedConfig(siteId) {
  const c = await getBlogConfig(siteId);
  const n = parseInt(c.feed_item_limit, 10);
  return {
    enabled: c.feed_enabled === "1",
    full: c.feed_full_content === "1",
    limit: Number.isInteger(n) ? Math.min(100, Math.max(1, n)) : 20,
    blogTitle: c.blog_index_title || "Blog",
  };
}

const ELIGIBLE = `p.site_id = $1 AND p.post_type = 'article' AND p.published = true
  AND (p.unpublish_at IS NULL OR p.unpublish_at > NOW()) AND p.published_at IS NOT NULL AND p.published_at <= NOW()
  AND s.noindex IS NOT TRUE`;

export async function getFeedItems(siteId, { categorySlug = null, limit = 20 } = {}) {
  const params = [siteId];
  let catSql = "";
  if (categorySlug) { params.push(categorySlug); catSql = ` AND c.slug = $${params.length}`; }
  params.push(limit);
  return (await query(
    `SELECT p.id, p.url_path, p.title, p.excerpt, p.content, p.featured_image, p.published_at, p.updated_at,
            c.name AS category_name, c.slug AS category_slug
     FROM pages p
     LEFT JOIN page_seo s ON s.page_id = p.id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${ELIGIBLE}${catSql}
     ORDER BY p.published_at DESC, p.id DESC LIMIT $${params.length}`, params)).rows;
}

export async function listFeedCategories(siteId) {
  return (await query(
    `SELECT DISTINCT c.slug, c.name FROM pages p
     LEFT JOIN page_seo s ON s.page_id = p.id JOIN categories c ON c.id = p.category_id
     WHERE ${ELIGIBLE} ORDER BY c.slug`, [siteId])).rows.filter((r) => SLUG_RE.test(r.slug));
}

function abs(baseUrl, p) { return /^https?:\/\//i.test(p) ? p : baseUrl.replace(/\/$/, "") + (p.startsWith("/") ? p : "/" + p); }

function buildRss({ title, description, baseUrl, selfPath, items, full, lastModified }) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push("<!-- cms-managed-feed -->");
  out.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">');
  out.push("<channel>");
  out.push(`<title>${xmlText(title)}</title>`);
  out.push(`<link>${xmlText(abs(baseUrl, "/blog"))}</link>`);
  out.push(`<description>${xmlText(description)}</description>`);
  out.push(`<lastBuildDate>${lastModified.toUTCString()}</lastBuildDate>`);
  out.push("<generator>CMS</generator>");
  out.push(`<atom:link href="${xmlText(abs(baseUrl, selfPath))}" rel="self" type="application/rss+xml"/>`);
  for (const it of items) {
    const url = abs(baseUrl, it.url_path);
    out.push("<item>");
    out.push(`<title>${xmlText(it.title)}</title>`);
    out.push(`<link>${xmlText(url)}</link>`);
    out.push(`<guid isPermaLink="true">${xmlText(url)}</guid>`);
    out.push(`<pubDate>${new Date(it.published_at).toUTCString()}</pubDate>`);
    if (it.category_name) out.push(`<category>${xmlText(it.category_name)}</category>`);
    out.push(`<description>${cdata(it.excerpt || deriveExcerptFromContent(it.content))}</description>`);
    if (full) out.push(`<content:encoded>${cdata(absolutizeHtml(it.content, baseUrl))}</content:encoded>`);
    if (it.featured_image) out.push(`<media:content url="${xmlText(abs(baseUrl, it.featured_image))}" medium="image"/>`);
    out.push("</item>");
  }
  out.push("</channel>", "</rss>");
  return out.join("\n") + "\n";
}

function buildAtom({ title, description, baseUrl, selfPath, items, full, lastModified, siteName }) {
  const self = abs(baseUrl, selfPath);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push("<!-- cms-managed-feed -->");
  out.push('<feed xmlns="http://www.w3.org/2005/Atom">');
  out.push(`<id>${xmlText(self)}</id>`);
  out.push(`<title>${xmlText(title)}</title>`);
  out.push(`<subtitle>${xmlText(description)}</subtitle>`);
  out.push(`<updated>${lastModified.toISOString()}</updated>`);
  out.push(`<link rel="self" type="application/atom+xml" href="${xmlText(self)}"/>`);
  out.push(`<link rel="alternate" type="text/html" href="${xmlText(abs(baseUrl, "/blog"))}"/>`);
  out.push(`<author><name>${xmlText(siteName)}</name></author>`);
  out.push("<generator>CMS</generator>");
  for (const it of items) {
    const url = abs(baseUrl, it.url_path);
    out.push("<entry>");
    out.push(`<id>${xmlText(url)}</id>`);
    out.push(`<title>${xmlText(it.title)}</title>`);
    out.push(`<link rel="alternate" type="text/html" href="${xmlText(url)}"/>`);
    out.push(`<published>${new Date(it.published_at).toISOString()}</published>`);
    out.push(`<updated>${new Date(it.updated_at || it.published_at).toISOString()}</updated>`);
    if (it.category_slug) out.push(`<category term="${xmlText(it.category_slug)}" label="${xmlText(it.category_name)}"/>`);
    out.push(`<summary type="html">${xmlText(it.excerpt || deriveExcerptFromContent(it.content))}</summary>`);
    if (full) out.push(`<content type="html">${xmlText(absolutizeHtml(it.content, baseUrl))}</content>`);
    out.push("</entry>");
  }
  out.push("</feed>");
  return out.join("\n") + "\n";
}

// Ritorna null se feed disattivo o categoria inesistente. Altrimenti { body, etag, lastModified, count }.
export async function renderFeed(siteId, { format = "rss", categorySlug = null, baseUrl } = {}) {
  const cfg = await getFeedConfig(siteId);
  if (!cfg.enabled) return null;
  let category = null;
  if (categorySlug) {
    if (!SLUG_RE.test(categorySlug)) return null;
    category = (await query("SELECT name, slug FROM categories WHERE site_id = $1 AND slug = $2", [siteId, categorySlug])).rows[0];
    if (!category) return null;
  }
  const items = await getFeedItems(siteId, { categorySlug, limit: cfg.limit });
  const siteName = (await query("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0]?.name || "";
  const title = [siteName, cfg.blogTitle, category?.name].filter(Boolean).join(" - ");
  const lastModified = items.reduce((m, it) => {
    const t = new Date(it.updated_at || it.published_at);
    return t > m ? t : m;
  }, new Date(0));
  const ctx = { title, description: siteName, baseUrl, selfPath: feedPath(format, categorySlug), items, full: cfg.full, lastModified, siteName };
  const body = format === "atom" ? buildAtom(ctx) : buildRss(ctx);
  return { body, etag: `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`, lastModified, count: items.length };
}

// Risolutore dei <link> di autodiscovery. Ritorna una funzione (urlPath) => string ("" se disattivo).
export async function makeFeedLinkResolver(siteId) {
  const cfg = await getFeedConfig(siteId);
  if (!cfg.enabled) return () => "";
  const siteName = (await query("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0]?.name || "";
  const cats = new Map((await listFeedCategories(siteId)).map((c) => [c.slug, c.name]));
  const title = [siteName, cfg.blogTitle].filter(Boolean).join(" - ");
  const link = (type, t, href) => `<link rel="alternate" type="${type}" title="${xmlText(t)}" href="${xmlText(href)}">`;
  return (urlPath) => {
    const lines = [link("application/rss+xml", title + " (RSS)", "/feed.xml"), link("application/atom+xml", title + " (Atom)", "/atom.xml")];
    const m = /^\/blog\/categoria\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/pagina\/\d+)?$/.exec(urlPath || "");
    if (m && cats.has(m[1])) {
      const t = `${title} - ${cats.get(m[1])}`;
      lines.push(link("application/rss+xml", t + " (RSS)", feedPath("rss", m[1])), link("application/atom+xml", t + " (Atom)", feedPath("atom", m[1])));
    }
    return lines.join("\n");
  };
}

const resolverCache = new Map(); // siteId -> { fn, at }
export async function getFeedLinkTags(siteId, urlPath, { ttlMs = 30000 } = {}) {
  const hit = resolverCache.get(siteId);
  if (hit && Date.now() - hit.at < ttlMs) return hit.fn(urlPath);
  const fn = await makeFeedLinkResolver(siteId);
  resolverCache.set(siteId, { fn, at: Date.now() });
  return fn(urlPath);
}
export function clearFeedLinkCache() { resolverCache.clear(); }

export function injectFeedLinks(html, tags) {
  if (!tags || typeof html !== "string") return html;
  const idx = html.search(/<\/head>/i);
  if (idx < 0) return html;
  return html.slice(0, idx) + tags + "\n" + html.slice(idx);
}

// Scrive i feed nella directory statica del sito e rimuove quelli non piu dovuti. dir = static/<siteId>.
export async function writeFeedFiles(siteId, baseUrl, dir) {
  const cfg = await getFeedConfig(siteId);
  const keep = new Set();
  const write = (rel, body) => {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = fp + ".tmp." + process.pid + "." + crypto.randomBytes(3).toString("hex");
    fs.writeFileSync(tmp, body, "utf-8");
    fs.renameSync(tmp, fp);
    keep.add(rel);
  };
  if (cfg.enabled) {
    for (const format of ["rss", "atom"]) {
      const r = await renderFeed(siteId, { format, baseUrl });
      if (r) write(feedPath(format).slice(1), r.body);
    }
    for (const c of await listFeedCategories(siteId)) {
      for (const format of ["rss", "atom"]) {
        const r = await renderFeed(siteId, { format, categorySlug: c.slug, baseUrl });
        if (r) write(feedPath(format, c.slug).slice(1), r.body);
      }
    }
  }
  // Si rimuovono SOLO file generati da noi (marcatore `cms-managed-feed` nei primi 200 byte): un feed.xml caricato a mano non si tocca mai.
  const isOurs = (fp) => { try { const fd = fs.openSync(fp, "r"); const b = Buffer.alloc(200); fs.readSync(fd, b, 0, 200, 0); fs.closeSync(fd); return b.toString("utf8").includes("cms-managed-feed"); } catch { return false; } };
  const dropIfOurs = (fp) => { if (isOurs(fp)) { try { fs.unlinkSync(fp); } catch { /* ignore */ } } };
  for (const rel of ["feed.xml", "atom.xml"]) {
    if (!keep.has(rel)) dropIfOurs(path.join(dir, rel));
  }
  const fdir = path.join(dir, "feed");
  if (fs.existsSync(fdir)) {
    for (const name of fs.readdirSync(fdir)) {
      const rel = "feed/" + name;
      if (name.endsWith(".xml") && !keep.has(rel)) dropIfOurs(path.join(fdir, name));
    }
  }
  return { written: keep.size };
}
