import { query } from "../db.js";

// Stesso pattern di tracking.js: riusa la tabella "settings" già esistente
// (per-sito, chiave/valore) invece di una tabella dedicata o nuove colonne
// su "sites" — nessuna migrazione necessaria, e già esposta via API agente
// generica (GET/PUT /api/agent/sites/:id/settings/:key).
const SEO_KEYS = {
  defaultOgImage: "seo_default_og_image",
  twitterHandle: "seo_twitter_handle",
  robotsExtra: "seo_robots_extra",
};

function emptyConfig() {
  const c = {};
  for (const field of Object.keys(SEO_KEYS)) c[field] = "";
  return c;
}

export async function getSiteSeoConfig(siteId) {
  if (!siteId) return emptyConfig();
  const rows = (await query(
    "SELECT key, value FROM settings WHERE site_id = $1 AND key = ANY($2)",
    [siteId, Object.values(SEO_KEYS)]
  )).rows;
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const c = {};
  for (const [field, key] of Object.entries(SEO_KEYS)) c[field] = map[key] || "";
  return c;
}

export async function setSiteSeoConfig(siteId, fields) {
  for (const [field, key] of Object.entries(SEO_KEYS)) {
    if (!(field in fields)) continue;
    const value = String(fields[field] ?? "").trim();
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
