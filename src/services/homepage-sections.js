import { query } from "../db.js";
import { renderCardTemplate, deriveExcerptFromContent, estimateReadingTime, formatShortDate } from "./blog-index.js";
import { getBlogConfig } from "./blog-settings.js";

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function resolveHomepageUrlPath(siteId) {
  const site = (await query(
    "SELECT homepage_path FROM sites WHERE id = $1",
    [siteId]
  )).rows[0];
  if (!site) return "/";
  if (!site.homepage_path || site.homepage_path === "/") return "/";
  return site.homepage_path;
}

export async function isHomepageDynamicEnabled(siteId) {
  const rows = (await query(
    "SELECT value FROM settings WHERE site_id = $1 AND key = $2",
    [siteId, "homepage_dynamic_enabled"]
  )).rows;
  return rows.length > 0 && rows[0].value === "true";
}

export async function setHomepageDynamicEnabled(siteId, enabled) {
  const value = enabled ? "true" : "false";
  await query(
    `INSERT INTO settings (site_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (site_id, key) DO UPDATE SET value = $3`,
    [siteId, "homepage_dynamic_enabled", value]
  );
}

export async function syncHomepageSections(siteId) {
  if (!(await isHomepageDynamicEnabled(siteId))) {
    return;
  }

  const homepageUrlPath = await resolveHomepageUrlPath(siteId);

  const sections = (await query(
    `SELECT id, position, section_type, category_id, title, articles_limit, custom_html, card_template_override, enable_client_filter
     FROM homepage_sections
     WHERE site_id = $1 AND enabled = true
     ORDER BY position ASC`,
    [siteId]
  )).rows;

  if (sections.length === 0) {
    return;
  }

  const config = await getBlogConfig(siteId);
  const imageToken = "HOMEPAGE_IMAGE_BLOCK_TOKEN";

  let html = "";

  if (config.homepage_custom_css) {
    html += `<style>${config.homepage_custom_css}</style>\n`;
  }

  for (const section of sections) {
    let sectionHtml = "";

    switch (section.section_type) {
      case "custom_html": {
        sectionHtml = section.custom_html || "";
        break;
      }

      case "category_band": {
        const categoriesWithArticles = (await query(
          `SELECT c.id, c.name, c.slug, c.color, c.icon,
           (SELECT count(*) FROM pages p WHERE p.category_id = c.id AND p.post_type = 'article' AND p.published = true) AS article_count
           FROM categories c
           WHERE c.site_id = $1
           AND EXISTS (SELECT 1 FROM pages p WHERE p.category_id = c.id AND p.post_type = 'article' AND p.published = true)
           ORDER BY c.name`,
          [siteId]
        )).rows;

        const categoryCards = categoriesWithArticles.map(cat => {
          const color = cat.color ? `style="color:${escapeAttr(cat.color)};"` : "";
          const icon = cat.icon ? `<span ${color} aria-hidden="true">${escapeAttr(cat.icon)}</span> ` : "";
          return `<a href="/blog/categoria/${escapeAttr(cat.slug)}" class="category-band-item">
            ${icon}<strong>${escapeAttr(cat.name)}</strong>
            <span class="article-count">(${cat.article_count})</span>
          </a>`;
        }).join("");

        sectionHtml = `<div class="category-band">${categoryCards}</div>`;
        break;
      }

      case "category_feed": {
        if (!section.category_id) break;

        const articles = (await query(
          `SELECT p.id, p.title, p.excerpt, p.featured_image, p.published_at, p.url_path, p.content,
            c.slug AS category_slug, c.icon AS category_icon
           FROM pages p
           LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.site_id = $1 AND p.post_type = 'article' AND p.published = true AND p.category_id = $2
           ORDER BY p.published_at DESC NULLS LAST, p.id DESC
           LIMIT $3`,
          [siteId, section.category_id, section.articles_limit]
        )).rows;

        const cards = articles.map(article => {
          const excerpt = article.excerpt || deriveExcerptFromContent(article.content);
          const publishedAt = article.published_at ? new Date(article.published_at).toLocaleDateString("it-IT") : "";
          const imageHtml = article.featured_image ? `<img src="${escapeAttr(article.featured_image)}" alt="">` : "";
          return renderCardTemplate(section.card_template_override || config.blog_card_template, {
            title: article.title,
            excerpt,
            url: article.url_path,
            image: imageToken,
            image_url: article.featured_image || "",
            published_at: publishedAt,
            published_at_short: formatShortDate(article.published_at),
            category_name: "",
            category_url: "",
            category_slug: article.category_slug || "",
            category_icon: article.category_icon || "",
            reading_time: estimateReadingTime(article.content),
          }).replaceAll(imageToken, imageHtml);
        }).join("\n");

        sectionHtml = `<div class="category-feed">${cards}</div>`;
        break;
      }

      case "all_feed": {
        const articles = (await query(
          `SELECT p.id, p.title, p.excerpt, p.featured_image, p.published_at, p.url_path, p.content, c.slug as category_slug, c.icon as category_icon
           FROM pages p
           LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.site_id = $1 AND p.post_type = 'article' AND p.published = true
           ORDER BY p.published_at DESC NULLS LAST, p.id DESC
           LIMIT $2`,
          [siteId, section.articles_limit]
        )).rows;

        const cards = articles.map(article => {
          const excerpt = article.excerpt || deriveExcerptFromContent(article.content);
          const publishedAt = article.published_at ? new Date(article.published_at).toLocaleDateString("it-IT") : "";
          const imageHtml = article.featured_image ? `<img src="${escapeAttr(article.featured_image)}" alt="">` : "";
          let cardHtml = renderCardTemplate(section.card_template_override || config.blog_card_template, {
            title: article.title,
            excerpt,
            url: article.url_path,
            image: imageToken,
            image_url: article.featured_image || "",
            published_at: publishedAt,
            published_at_short: formatShortDate(article.published_at),
            category_name: "",
            category_url: "",
            category_slug: article.category_slug || "",
            category_icon: article.category_icon || "",
            reading_time: estimateReadingTime(article.content),
          }).replaceAll(imageToken, imageHtml);

          if (section.enable_client_filter && article.category_slug) {
            cardHtml = cardHtml.replace(/^<article/, `<article data-category="${escapeAttr(article.category_slug)}"`);
          }
          return cardHtml;
        }).join("\n");

        sectionHtml = `<div class="all-feed">${cards}</div>`;
        break;
      }
    }

    if (sectionHtml) {
      html += sectionHtml + "\n";
    }
  }

  if (config.homepage_custom_js) {
    html += `<script>${config.homepage_custom_js}</script>\n`;
  }

  // layout_mode NON viene forzato: una homepage già standalone (HTML
  // completo scritto a mano, es. vicchina.it) deve restare standalone,
  // altrimenti l'output smette di essere identico a quello statico.
  await query(
    `UPDATE pages
     SET content = $1, managed_by = 'homepage', updated_at = NOW()
     WHERE site_id = $2 AND url_path = $3`,
    [html, siteId, homepageUrlPath]
  );
}

export async function activateHomepageDynamic(siteId) {
  const homepageUrlPath = await resolveHomepageUrlPath(siteId);

  const existingSections = (await query(
    "SELECT 1 FROM homepage_sections WHERE site_id = $1 LIMIT 1",
    [siteId]
  )).rows;

  if (existingSections.length === 0) {
    const currentHomepage = (await query(
      "SELECT content FROM pages WHERE site_id = $1 AND url_path = $2 AND published = true",
      [siteId, homepageUrlPath]
    )).rows[0];

    if (currentHomepage) {
      await query(
        `INSERT INTO homepage_sections (site_id, position, section_type, title, custom_html, enabled)
         VALUES ($1, 0, 'custom_html', 'Contenuto esistente', $2, true)`,
        [siteId, currentHomepage.content]
      );
    }
  }

  await setHomepageDynamicEnabled(siteId, true);
  await syncHomepageSections(siteId);
}

export async function deactivateHomepageDynamic(siteId) {
  await setHomepageDynamicEnabled(siteId, false);

  const homepageUrlPath = await resolveHomepageUrlPath(siteId);
  await query(
    "UPDATE pages SET managed_by = NULL WHERE site_id = $1 AND url_path = $2",
    [siteId, homepageUrlPath]
  );
}