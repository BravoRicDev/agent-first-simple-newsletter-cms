import { query } from "../db.js";

export const DEFAULTS = {
  blog_articles_per_page: "10",
  blog_card_template: `<article class="blog-card">
  {{image}}
  <h2><a href="{{url}}">{{title}}</a></h2>
  <p class="meta">{{category_name}} — {{published_at}}</p>
  <p>{{excerpt}}</p>
</article>`,
  blog_article_embed_template: `<article class="article-embed">
  {{image}}
  <h1>{{title}}</h1>
  <p class="meta">{{category_name}} — {{published_at}}</p>
  {{content}}
</article>`,
  blog_index_title: "Blog",
  blog_index_intro_html: "",
  homepage_custom_css: "",
  homepage_custom_js: "",
  feed_enabled: "0",
  feed_item_limit: "20",
  feed_full_content: "0",
  search_enabled: "0",
  search_language: "italian",
  editorial_workflow_enabled: "0",
  images_srcset_mode: "0",
};

export async function getBlogConfig(siteId) {
  if (!siteId) return { ...DEFAULTS };
  const keys = Object.keys(DEFAULTS);
  const rows = (await query(
    "SELECT key, value FROM settings WHERE site_id = $1 AND key = ANY($2)",
    [siteId, keys]
  )).rows;
  const map = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return { ...DEFAULTS, ...map };
}

export async function setBlogConfig(siteId, fields) {
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in fields)) continue;
    const value = String(fields[key] ?? "").trim();
    if (value) {
      await query(
        `INSERT INTO settings (site_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (site_id, key) DO UPDATE SET value = $3`,
        [siteId, key, value]
      );
    } else {
      await query("DELETE FROM settings WHERE site_id = $1 AND key = $2", [siteId, key]);
    }
  }
  invalidateBlogSettingCache(siteId);
  if ("search_language" in fields) {
    import("./search.js").then((m) => m.reindexSite?.(siteId)).catch(() => {});
  }
}

const settingCache = new Map(); // `${siteId}:${key}` -> { value, at }

export function invalidateBlogSettingCache(siteId) {
  for (const k of [...settingCache.keys()]) if (!siteId || k.startsWith(`${siteId}:`)) settingCache.delete(k);
}

// Lettura singola con cache breve (15s): usata sui percorsi caldi (serve.js, guard).
export async function getBlogSetting(siteId, key, { ttlMs = 15000 } = {}) {
  if (!siteId || !(key in DEFAULTS)) return DEFAULTS[key] ?? "";
  const ck = `${siteId}:${key}`;
  const hit = settingCache.get(ck);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const row = (await query("SELECT value FROM settings WHERE site_id = $1 AND key = $2", [siteId, key])).rows[0];
  const value = row ? row.value : DEFAULTS[key];
  settingCache.set(ck, { value, at: Date.now() });
  return value;
}
