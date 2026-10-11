import { query } from "../db.js";
import { getBlogConfig } from "./blog-settings.js";
import { logger } from "./logger.js";

export function renderCardTemplate(template, data) {
  return String(template || "").replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const value = path.trim().split(".").reduce((current, key) => current == null ? current : current[key], data);
    if (value === undefined || value === null) return "";
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  });
}

export function deriveExcerptFromContent(html, maxLen = 200) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s{2,}/g, " ").trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

export function estimateReadingTime(html, wordsPerMinute = 200) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s{2,}/g, " ").trim();
  const wordCount = text.split(/\s+/).filter(word => word.length > 0).length;
  return Math.max(1, Math.round(wordCount / wordsPerMinute));
}

export function formatShortDate(date, locale = "it-IT") {
  if (!date) return "";
  return new Date(date).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/\"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pagePath(basePath, page) {
  if (page === 1) return basePath;
  return basePath === "/blog" ? `/blog/pagina/${page}` : `${basePath}/pagina/${page}`;
}

function pagination(currentPage, totalPages, basePath) {
  if (totalPages <= 1) return "";
  const links = [];
  if (currentPage > 1) links.push(`<a href="${pagePath(basePath, currentPage - 1)}">« Precedente</a>`);
  if (currentPage < totalPages) links.push(`<a href="${pagePath(basePath, currentPage + 1)}">Successiva »</a>`);
  return `<nav class="blog-pagination">${links.join(" | ")}</nav>`;
}

async function upsertListing({ siteId, urlPath, title, content, managedBy, writtenIds }) {
  const human = (await query(
    "SELECT id FROM pages WHERE site_id = $1 AND url_path = $2 AND managed_by IS NULL",
    [siteId, urlPath]
  )).rows[0];
  if (human) {
    logger.warn("Blog listing skipped to preserve manually managed page", { url_path: urlPath, site_id: siteId });
    return;
  }
  const result = await query(
    `INSERT INTO pages (site_id, url_path, title, content, post_type, managed_by, layout_mode, published)
     VALUES ($1, $2, $3, $4, 'page', $5, 'wrapped', true)
     ON CONFLICT (site_id, url_path) DO UPDATE SET content = EXCLUDED.content,
       title = EXCLUDED.title, managed_by = EXCLUDED.managed_by, post_type = EXCLUDED.post_type,
       layout_mode = EXCLUDED.layout_mode, published = EXCLUDED.published, updated_at = NOW()
     RETURNING id`,
    [siteId, urlPath, title, content, managedBy]
  );
  if (result.rows[0]) writtenIds.push(result.rows[0].id);
}

export async function syncBlogListingPages(siteId) {
  const config = await getBlogConfig(siteId);
  const parsedPerPage = parseInt(config.blog_articles_per_page, 10);
  const perPage = parsedPerPage || 10;
  const articles = (await query(
    `SELECT id, title, excerpt, featured_image, published_at, url_path, category_id, content, reading_time_minutes
     FROM pages WHERE site_id = $1 AND post_type = 'article' AND published = true
     ORDER BY published_at DESC NULLS LAST, id DESC`,
    [siteId]
  )).rows;
  const categories = (await query(
    "SELECT id, name, slug, icon FROM categories WHERE site_id = $1",
    [siteId]
  )).rows;
  const categoriesById = new Map(categories.map(category => [category.id, category]));
  const writtenIds = [];

  const renderCards = list => list.map(article => {
    const category = categoriesById.get(article.category_id);
    const excerpt = article.excerpt || deriveExcerptFromContent(article.content);
    const publishedAt = article.published_at ? new Date(article.published_at).toLocaleDateString("it-IT") : "";
    const imageHtml = article.featured_image ? `<img src="${escapeAttr(article.featured_image)}" alt="">` : "";
    // Render the user-controlled values through the escaping renderer, then
    // restore only the generated image block (the sole trusted HTML value).
    const imageToken = "BLOG_IMAGE_BLOCK_TOKEN";
    return renderCardTemplate(config.blog_card_template, {
      title: article.title,
      excerpt,
      url: article.url_path,
      image: imageToken,
      image_url: article.featured_image || "",
      published_at: publishedAt,
      published_at_short: formatShortDate(article.published_at),
      category_name: category ? category.name : "",
      category_url: category ? `/blog/categoria/${category.slug}` : "",
      category_slug: category ? category.slug : "",
      category_icon: category ? category.icon || "" : "",
      reading_time: article.reading_time_minutes ?? estimateReadingTime(article.content),
    }).replaceAll(imageToken, imageHtml);
  }).join("\n");

  async function renderListing(list, basePath, managedBy, isGlobal) {
    const totalPages = Math.ceil(list.length / perPage);
    for (let page = 1; page <= totalPages; page++) {
      const current = list.slice((page - 1) * perPage, page * perPage);
      const title = page === 1 ? config.blog_index_title : `${config.blog_index_title} — pagina ${page}`;
      const intro = isGlobal && page === 1 ? config.blog_index_intro_html : "";
      const content = `${intro}${renderCards(current)}${pagination(page, totalPages, basePath)}`;
      await upsertListing({ siteId, urlPath: pagePath(basePath, page), title, content, managedBy, writtenIds });
    }
  }

  if (articles.length > 0) {
    await renderListing(articles, "/blog", "blog_index", true);
    const categoryIds = new Set(articles.map(article => article.category_id).filter(id => id != null));
    for (const categoryId of categoryIds) {
      const category = categoriesById.get(categoryId);
      if (!category) continue;
      const categoryArticles = articles.filter(article => article.category_id === categoryId);
      await renderListing(categoryArticles, `/blog/categoria/${category.slug}`, `blog_category:${category.id}`, false);
    }
  }

  await query(
    "DELETE FROM pages WHERE site_id = $1 AND managed_by IS NOT NULL AND id != ALL($2::int[])",
    [siteId, writtenIds]
  );
}
