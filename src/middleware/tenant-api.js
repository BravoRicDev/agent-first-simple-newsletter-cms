import crypto from "crypto";
import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Middleware tenancy + auth per la surface API compatibile ("API compatibili
// con CRM diffusi"), montata su /v1.
//
// - Il tenant (sito) viene risolto dall'header `Location-Id`: può essere un
//   id numerico (sites.id), il domain del sito, oppure l'UUID della location
//    (sites.crm_location_id). È l'unità di tenancy.
// - L'autenticazione avviene via Bearer token: l'API key del SITO (tabella
//   site_api_keys), salvata SOLO come SHA-256 hex (mai in chiaro nel DB).
// - Header `Version:` IGNORATO volutamente: alcuni client "CRM-diffusi"
//   mandano un header Version per la compat API. Noi non versioniamo per
//   header e lo leggiamo e ignoriamo esplicitamente, così quelle richieste
//   proseguono senza errori. È una scelta documentata di compatibilità.
// ─────────────────────────────────────────────────────────────────────────

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

// Noop esplicito per chiarezza: legge (via opzionale) e NON usa l'header Version.
export function ignoredVersionHeader(req) {
  // Nota: req.get("Version") è volutamente non letto/NON applicato.
  return undefined;
}

export function requireTenant() {
  return async (req, res, next) => {
    const locationId = String(req.get("Location-Id") || "").trim();

    // Header `Version:` ignorato (compatibilità client). Vedere commento in testa.
    ignoredVersionHeader(req);

    if (!locationId) {
      return res.status(401).json({ error: "Tenant non identificato: header Location-Id mancante" });
    }

    // Risolvi il sito: se è numerico usa id; altrimenti prova prima il
    // domain, poi il mapping location CRM (sites.crm_location_id) così un
    // nodo n8n può passare l'UUID della location  per
    // identificare il sito/tenant del CMS.
    let site;
    try {
      if (/^\d+$/.test(locationId)) {
        const r = await query("SELECT * FROM sites WHERE id = $1", [parseInt(locationId, 10)]);
        site = r.rows[0] || null;
      } else {
        // Domain prima, poi location CRM (più specifica del tenant).
        const byDomain = await query("SELECT * FROM sites WHERE domain = $1", [locationId]);
        site = byDomain.rows[0] || null;
        if (!site) {
          const byLocation = await query("SELECT * FROM sites WHERE crm_location_id = $1", [locationId]);
          site = byLocation.rows[0] || null;
        }
      }
    } catch (err) {
      return next(err);
    }
    if (!site) {
      return res.status(404).json({ error: "Tenant non trovato" });
    }

    // Auth Bearer: API key del sito.
    const authHeader = String(req.get("Authorization") || "");
    const rawToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
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

    req.tenant = { siteId: site.id, site };
    next();
  };
}
