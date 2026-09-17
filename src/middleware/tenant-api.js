import crypto from "crypto";
import { query } from "../db.js";
import { isApiTokenFormat, verifyApiToken } from "../services/api-tokens.js";
import { apiTokenScopeGate } from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────
// Middleware tenancy + auth per la surface API compatibile ("API compatibili
// con CRM diffusi"), montata su /v1. Condivide con middleware/api-dialect.js
// (surface clone, vhost sites.api_domain) la risoluzione del sito e il
// dialetto "agent" (agtok_) — vedi resolveSiteByLocationId/resolveAgentTenant
// sotto, entrambi esportati per evitare due implementazioni divergenti.
//
// - Il tenant (sito) viene risolto dall'header `Location-Id`: può essere un
//   id numerico (sites.id), il domain del sito, oppure l'identificativo
//   esterno della location (sites.location_external_id). È l'unità di tenancy.
// - L'autenticazione avviene via Bearer token, in due dialetti:
//   1. site_api_key (tabella site_api_keys, hash SHA-256) — comportamento
//      storico, invariato.
//   2. agent (agtok_, tabella api_tokens) — un satellite/automazione con UN
//      SOLO token può leggere/scrivere su PIÙ siti passando Location-Id,
//      con la stessa regola multi-sito del resto del CMS: il superadmin
//      sceglie il sito, chiunque altro è vincolato al proprio site_id
//      (altrimenti 403 — previene che un agtok_ normale legga siti altrui
//      solo cambiando l'header).
// - Header `Version:` IGNORATO volutamente su questa surface: alcuni client
//   "CRM-diffusi" mandano un header Version per la compat API. Noi non
//   versioniamo per header e lo leggiamo e ignoriamo esplicitamente, così
//   quelle richieste proseguono senza errori. È una scelta documentata di
//   compatibilità (il dialetto agent non lo richiede per lo stesso motivo).
// ─────────────────────────────────────────────────────────────────────────

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

// Noop esplicito per chiarezza: legge (via opzionale) e NON usa l'header Version.
export function ignoredVersionHeader(req) {
  // Nota: req.get("Version") è volutamente non letto/NON applicato.
  return undefined;
}

// Risolve il sito dal Location-Id: numerico → sites.id, altrimenti prova
// prima il domain e poi l'identificativo esterno della location (mapping
// Location ↔ Site). Condivisa da entrambe le surface (v1 e clone) per non
// avere due logiche di risoluzione che possono divergere.
export async function resolveSiteByLocationId(locationId) {
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

function bearerTokenOf(req) {
  const authHeader = String(req.get("Authorization") || "");
  return authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
}

// Dialetto "agent": riconosce un agtok_ (tabella api_tokens, stesso token
// usato su /api/*) e risolve req.tenant dal Location-Id, applicando la
// regola multi-sito. Ritorna:
//   - null                          se il bearer NON è in formato agtok_
//                                    (il chiamante prosegue col proprio
//                                    dialetto: site_api_key/legacy/modern)
//   - { status, body }              su fallimento (401/403) — il chiamante
//                                    deve rispondere così e fermarsi
//   - { user, tenant }              su successo — il chiamante deve
//                                    impostare req.user/req.tenant e passare
//                                    ad apiTokenScopeGate() prima di next()
//
// Un punto solo: sia tenant-api.js (/v1) sia api-dialect.js (clone) lo
// chiamano, così le due surface restano sempre allineate.
export async function resolveAgentTenant(req) {
  const rawToken = bearerTokenOf(req);
  if (!isApiTokenFormat(rawToken)) return null;

  let user;
  try {
    user = await verifyApiToken(rawToken);
  } catch {
    return { status: 503, body: { error: "service_unavailable" } };
  }
  if (!user) return { status: 401, body: { error: "invalid_token" } };

  const locationId = String(
    req.get("Location-Id") || req.query?.locationId || req.body?.locationId || ""
  ).trim();
  if (!locationId) return { status: 401, body: { error: "location_id_required" } };

  let site;
  try {
    site = await resolveSiteByLocationId(locationId);
  } catch {
    return { status: 401, body: { error: "invalid_token" } };
  }
  if (!site) return { status: 401, body: { error: "invalid_token" } };

  // Regola multi-sito: solo il superadmin può scegliere il sito passando
  // Location-Id; chiunque altro resta vincolato al proprio site_id (altrimenti
  // un agtok_ qualunque potrebbe leggere/scrivere su siti altrui cambiando
  // solo l'header — escalation di privilegi).
  const isSuperadmin = user.role === "superadmin";
  if (!isSuperadmin && user.site_id !== site.id) {
    return { status: 403, body: { error: "forbidden_site" } };
  }

  return {
    user,
    tenant: {
      siteId: site.id,
      site,
      locationExternalId: site.location_external_id ?? null,
    },
  };
}

export function requireTenant() {
  return async (req, res, next) => {
    // Dialetto agent (agtok_): controllato PRIMA di assumere un site_api_key,
    // perché il discriminante qui sotto (assenza di rawToken in site_api_keys)
    // non distingue i due formati — un agtok_ senza questo check anticipato
    // fallirebbe sempre la verifica contro site_api_keys con un 401 generico.
    const agentResult = await resolveAgentTenant(req);
    if (agentResult) {
      if (agentResult.status) {
        return res.status(agentResult.status).json({ error: agentResult.body.error });
      }
      req.user = agentResult.user;
      req.tenant = agentResult.tenant;
      req.apiDialect = "agent";
      if (!apiTokenScopeGate(req, res)) return undefined;
      return next();
    }

    const locationId = String(req.get("Location-Id") || "").trim();

    // Header `Version:` ignorato (compatibilità client). Vedere commento in testa.
    ignoredVersionHeader(req);

    if (!locationId) {
      return res.status(401).json({ error: "Tenant non identificato: header Location-Id mancante" });
    }

    let site;
    try {
      site = await resolveSiteByLocationId(locationId);
    } catch (err) {
      return next(err);
    }
    if (!site) {
      return res.status(404).json({ error: "Tenant non trovato" });
    }

    // Auth Bearer: API key del sito.
    const rawToken = bearerTokenOf(req);
    if (!rawToken) {
      return res.status(401).json({ error: "API key mancante: header Authorization Bearer richiesto" });
    }

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
    if (!keyRow || !keyRow.active) {
      return res.status(401).json({ error: "API key non valida" });
    }

    // Aggiorna last_used_at (fire-and-forget, non blocca la richiesta).
    query("UPDATE site_api_keys SET last_used_at = NOW() WHERE id = $1", [keyRow.id]).catch(() => {});

    req.tenant = {
      siteId: site.id,
      site,
      // Mapping Location ↔ Site: esposto verso i consumer (es. n8n) così il
      // valore è leggibile anche fuori dal DB.
      locationExternalId: site.location_external_id ?? null,
    };
    req.apiDialect = "legacy";
    next();
  };
}
