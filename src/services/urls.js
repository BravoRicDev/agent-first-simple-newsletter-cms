import { query } from "../db.js";

const VALID_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

// URL pubblica "di verità" di un sito, per sitemap/robots/canonical/OG —
// unico punto di risoluzione del dominio: prima del consolidamento qui,
// serve.js usava site_domains (con fallback all'host della richiesta) e
// static-export.js usava invece la colonna legacy sites.domain, quindi
// canonical/sitemap potevano finire con domini diversi tra live e statico.
// Il fallback all'header Host (solo in contesto richiesta) è validato con
// una regex hostname: l'header è controllabile dal client, quindi non ci si
// fida mai ciecamente (era una vulnerabilità di host header poisoning).
export async function getCanonicalBaseUrl(siteId, { req } = {}) {
  const domains = (await query(
    "SELECT domain FROM site_domains WHERE site_id = $1 ORDER BY id LIMIT 1",
    [siteId]
  )).rows;
  if (domains.length > 0) {
    return `https://${domains[0].domain}`;
  }
  if (req) {
    const host = String(req.get("host") || "");
    if (VALID_HOSTNAME.test(host)) {
      return `${req.protocol}://${host}`;
    }
    return "https://localhost";
  }
  // Contesto non-request (export statico, nessun host da leggere): ultima
  // risorsa, la colonna legacy sites.domain.
  const site = (await query("SELECT domain FROM sites WHERE id = $1", [siteId])).rows[0];
  return site?.domain ? `https://${site.domain}` : "https://localhost";
}

export function normalizeUrlPath(rawPath) {
  if (typeof rawPath !== "string") throw new Error("URL non valido");
  const trimmed = rawPath.trim();
  if (
    /\s/.test(trimmed) ||
    trimmed.includes("..") ||
    // Path traversal encoded: %2e%2e non è bloccato dal check ".." letterale.
    /%(?:2e|2E)/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    // Query/fragment in un url_path: finivano nelle sitemap come `loc` con
    // query string e creavano URL incoerenti tra DB, export e routing.
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    // Protocol-relative `//evil.com`: passava a res.redirect() e diventava
    // un open redirect verso un dominio arbitrario.
    trimmed.startsWith("//")
  ) {
    throw new Error("URL non valido");
  }
  const collapsed = trimmed.replace(/\/+/g, "/");
  const stripped = collapsed.replace(/^\/+|\/+$/g, "");
  return "/" + stripped;
}
