import crypto from "crypto";
import { query } from "../db.js";
import config from "../config.js";
import { requireTenant } from "./tenant-api.js";

// ─────────────────────────────────────────────────────────────────────────
// Adattatore dual-dialect per il router clone (src/routes/api-clone/):
// risolve tenant+auth accettando ENTRAMBI gli stili di autenticazione del
// target, in quest'ordine:
//
// 1. Legacy: header Location-Id + Bearer sitekey_... → riusa esattamente
//    la logica di tenant-api.js (già usata da /v1).
// 2. Moderno: Bearer + locationId in query/body + header Version, validato
//    contro config.supportedApiVersions (assente → default all'ultima
//    supportata, non supportata → 400).
// 3. Nessuna credenziale valida → 401.
//
// Output uniforme su successo: req.tenant, req.apiDialect ("legacy"|"modern"),
// req.apiVersion (solo dialetto moderno). Errori in shape {statusCode,message}
// (stile target), tranne il dialetto legacy che propaga gli errori originali
// di tenant-api.js (stile {error} già consolidato su /v1).
// ─────────────────────────────────────────────────────────────────────────

const legacyTenantMiddleware = requireTenant();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function resolveSiteByLocationId(locationId) {
  if (/^\d+$/.test(locationId)) {
    const r = await query("SELECT * FROM sites WHERE id = $1", [parseInt(locationId, 10)]);
    return r.rows[0] || null;
  }
  let r = await query("SELECT * FROM sites WHERE domain = $1", [locationId]);
  if (r.rows[0]) return r.rows[0];
  if (locationId.length <= 255) {
    r = await query("SELECT * FROM sites WHERE location_external_id = $1", [locationId]);
    return r.rows[0] || null;
  }
  return null;
}

function unauthenticated(res) {
  return res.status(401).json({ statusCode: 401, message: "Non autenticato" });
}

export function apiDialect() {
  return async (req, res, next) => {
    // Dialetto legacy: presenza dell'header Location-Id è il discriminante
    // (coerente con /v1: requireTenant risponde da sé 401/404 in caso di
    // credenziali mancanti/errate, con lo shape {error} già in uso lì).
    if (req.get("Location-Id")) {
      return legacyTenantMiddleware(req, res, (err) => {
        if (err) return next(err);
        req.apiDialect = "legacy";
        next();
      });
    }

    const authHeader = String(req.get("Authorization") || "");
    const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    const locationId = String(req.query?.locationId || req.body?.locationId || "").trim();

    // Dialetto moderno: Bearer + locationId (query/body) + header Version.
    if (rawToken && locationId) {
      let site;
      try {
        site = await resolveSiteByLocationId(locationId);
      } catch (err) {
        return next(err);
      }
      if (!site) return unauthenticated(res);

      let keyRow;
      try {
        const r = await query(
          "SELECT id, active FROM site_api_keys WHERE token_hash = $1 AND site_id = $2",
          [sha256(rawToken), site.id]
        );
        keyRow = r.rows[0] || null;
      } catch (err) {
        return next(err);
      }
      if (!keyRow || !keyRow.active) return unauthenticated(res);

      const requestedVersion = String(req.get("Version") || "").trim();
      const supported = config.supportedApiVersions;
      let apiVersion;
      if (!requestedVersion) {
        apiVersion = supported[supported.length - 1];
      } else if (!supported.includes(requestedVersion)) {
        // Shape BadRequestDto documentata del target: {statusCode,message}
        // con message generico "Bad Request" (verificato su spec/examples).
        return res.status(400).json({ statusCode: 400, message: "Bad Request" });
      } else {
        apiVersion = requestedVersion;
      }

      query("UPDATE site_api_keys SET last_used_at = NOW() WHERE id = $1", [keyRow.id]).catch(() => {});

      req.tenant = {
        siteId: site.id,
        site,
        locationExternalId: site.location_external_id ?? null,
      };
      req.apiDialect = "modern";
      req.apiVersion = apiVersion;
      return next();
    }

    // Dialetto OAuth (fase G, non ancora implementato): Bearer access_token
    // di un'app terza registrata + scope check.
    // if (rawToken) { ... risoluzione OAuth provider qui ... }

    return unauthenticated(res);
  };
}
