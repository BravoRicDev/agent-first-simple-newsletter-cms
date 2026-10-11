import { query } from "../db.js";

export const DEFAULTS = {
  blog_articles_per_page: "10",
  blog_card_template: `<article class="blog-card">
  {{image}}
  <h2><a href="{{url}}">{{title}}</a></h2>
  <p class="meta">{{category_name}} — {{published_at}}</p>
  <p>{{excerpt}}</p>
</article>`,
  blog_index_title: "Blog",
  blog_index_intro_html: "",
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
}
