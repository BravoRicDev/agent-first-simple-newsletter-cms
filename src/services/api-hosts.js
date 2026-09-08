import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Lookup hostname → sito per il vhost API dedicato (sites.api_domain).
// Cache in memoria con TTL 60s: ogni richiesta sul vhost API farebbe
// altrimenti una query per risolvere il tenant prima ancora di autenticare.
// Invalidazione esplicita quando l'admin cambia api_domain da UI (vedi
// invalidateApiHost in routes/sites.js).
// ─────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // hostname normalizzato -> { site, expiresAt }

// Il Host header può includere la porta (es. "apicrm.esempio.it:3000") e
// arrivare con maiuscole: sites.api_domain è salvato lowercase senza porta.
export function normalizeApiHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/:\d+$/, "");
}

export async function findSiteByApiDomain(hostname) {
  const host = normalizeApiHostname(hostname);
  if (!host) return null;

  const cached = cache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.site;

  const result = await query(
    "SELECT * FROM sites WHERE api_domain = $1 AND api_domain IS NOT NULL",
    [host]
  );
  const site = result.rows[0] || null;
  cache.set(host, { site, expiresAt: Date.now() + CACHE_TTL_MS });
  return site;
}

// hostname assente = svuota tutta la cache (usato quando non si conosce
// il vecchio valore, es. dopo un cambio non tracciato a mano).
export function invalidateApiHost(hostname) {
  if (hostname) {
    cache.delete(normalizeApiHostname(hostname));
  } else {
    cache.clear();
  }
}
