import { query } from "../../../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Dettagli Location/Business del CRM sorgente (GET /locations/{locationId}):
// ragione sociale, indirizzo, contatti, timezone. Un solo record per sito
// (non una lista): upsert diretto ON CONFLICT(site_id), non
// upsertByExternalId (pensata per liste keyed su ghl_id).
//
// Sotto-prodotto utile: loc.companyId sblocca la sync utenti (GET
// /users/search lo richiede come "companyId"/agencyId — mappers/users.js
// salta la sync se cfg.company_id è vuoto). Per questo location-info gira
// PRIMA di users nello SWEEP_ORDER (src/services/source-sync/index.js): se
// company_id non è già configurato esplicitamente, lo popoliamo qui da
// loc.companyId sia su source_sync_config (persistente, per i run futuri)
// sia su ctx.cfg (in memoria, per sbloccare subito users nello STESSO run).
// ─────────────────────────────────────────────────────────────────────────

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    // sendLocationId:false — locationId già nel path.
    const res = await client.get(`/locations/${cfg.location_id}`, {}, { sendLocationId: false });
    const loc = res?.location || res || {};
    addStat("location-info", "fetched", 1);

    if (!loc.id && !loc.name) {
      // Risposta vuota/inattesa: non sovrascrivere un record valido con dati
      // vuoti, ma segnala comunque (non è un "successo silenzioso").
      addStat("location-info", "errors", 1);
      log(`location-info: risposta inattesa (${JSON.stringify(res).slice(0, 200)})`);
      return;
    }

    if (dryRun) {
      addStat("location-info", "updated", 1);
      return;
    }

    await query(
      `INSERT INTO ghl_location_info
         (site_id, ghl_id, name, address, city, state, postal_code, country, phone, email, website, timezone, company_id, raw, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       ON CONFLICT (site_id) DO UPDATE SET
         ghl_id = EXCLUDED.ghl_id, name = EXCLUDED.name, address = EXCLUDED.address,
         city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code,
         country = EXCLUDED.country, phone = EXCLUDED.phone, email = EXCLUDED.email,
         website = EXCLUDED.website, timezone = EXCLUDED.timezone,
         company_id = CASE WHEN EXCLUDED.company_id <> '' THEN EXCLUDED.company_id ELSE ghl_location_info.company_id END,
         raw = EXCLUDED.raw, updated_at = NOW()`,
      [
        siteId,
        loc.id || "",
        loc.name || "",
        loc.address || "",
        loc.city || "",
        loc.state || "",
        loc.postalCode || "",
        loc.country || "",
        loc.phone || "",
        loc.email || "",
        loc.website || "",
        loc.timezone || "",
        loc.companyId || "",
        JSON.stringify(loc),
      ]
    );
    addStat("location-info", "updated", 1);

    // Bootstrap company_id per sbloccare users.js — solo se non già
    // configurato esplicitamente (non sovrascrivere una scelta manuale).
    if (!cfg.company_id && loc.companyId) {
      await query("UPDATE source_sync_config SET company_id = $1 WHERE site_id = $2", [loc.companyId, siteId]);
      cfg.company_id = loc.companyId; // in-memory: sblocca users nello stesso run
      log(`location-info: company_id popolato da loc.companyId (${loc.companyId})`);
    }
  } catch (err) {
    addStat("location-info", "errors", 1);
    log(`syncAll location-info fallito: ${err.message}`);
    throw err;
  }
}
