import { query } from "../../../db.js";
import { upsertByExternalId } from "../upsert.js";

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  // GET /users?locationId (legacy) è deprecato e rimosso sull'API attuale —
  // doc CRM sorgente 2021-07-28: "Deprecated. Use GET /users/search instead", che
  // richiede companyId (agencyId) oltre a locationId, con paginazione a
  // offset (skip/limit) invece che a cursore.
  if (!cfg.company_id) {
    addStat("users", "errors", 1);
    log("syncAll users saltato: company_id non configurato (richiesto da GET /users/search)");
    return;
  }

  try {
    await client.paginateOffset(
      "/users/search",
      { companyId: cfg.company_id, locationId: cfg.location_id },
      async (users) => { await syncUsersPage(ctx, users); }
    );
  } catch (err) {
    addStat("users", "errors", 1);
    log(`syncAll users fallito: ${err.message}`);
    throw err;
  }
}

async function syncUsersPage(ctx, users) {
  const { siteId, dryRun, addStat, log } = ctx;
  addStat("users", "fetched", users.length);

  for (const u of users) {
    try {
      // Doc CRM sorgente 2021-07-28 (Get User): il ruolo è u.roles.role (oggetto
      // annidato { type, role, locationIds }), NON un campo stringa u.role
      // di primo livello — quest'ultimo non esiste mai, quindi ogni utente
      // finiva sempre "collaboratore". L'oggetto user non ha dateAdded/
      // dateUpdated: nessun campo del genere in nessuna versione della doc,
      // quindi non li passiamo (upsertByExternalId usa la data di sync).
      const role = u.roles?.role === "admin" ? "admin" : "collaboratore";
      const cols = {
        email: u.email,
        name: u.name || "",
        role,
        status: "active",
      };

      if (dryRun) continue;

      const { action } = await upsertByExternalId({
        table: "users",
        siteId,
        externalId: u.id,
        cols,
      });

      if (action === "inserted") addStat("users", "upserted", 1);
      else if (action === "updated") addStat("users", "updated", 1);
      else addStat("users", "skipped", 1);
    } catch (err) {
      // Postgres: duplicate key value violates unique constraint "users_email_key"
      if (err.message?.includes("duplicate key") && err.message?.includes("email")) {
        const existing = (
          await query("SELECT id, external_id FROM users WHERE email = $1 LIMIT 1", [u.email])
        ).rows[0];
        // S1 v2: adotta il record locale esistente (stessa email) quando il
        // suo external_id NON è quello sorgente (migrazione 090: external_id
        // locale è un UUID sempre valorizzato → il vecchio check
        // "!existing.external_id" non scattava mai e l'utente GHL non veniva
        // importato).
        if (existing && existing.external_id !== u.id) {
          if (!dryRun) {
            await query("UPDATE users SET external_id = $1 WHERE id = $2", [u.id, existing.id]);
          }
          addStat("users", "updated", 1);
          continue;
        }
      }
      addStat("users", "errors", 1);
      log(`user ${u.email}: ${err.message}`);
    }
  }
}
