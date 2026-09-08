import { upsertByExternalId } from "../upsert.js";

// ─────────────────────────────────────────────────────────────────────────
// Workflow del CRM sorgente (GET /workflows/): copia in sola lettura, id +
// nome + stato + payload integrale in JSONB — gli step/trigger dettagliati
// non sono esposti da questo endpoint, solo la definizione riassuntiva.
// Tabella ghl_workflows: NON confondere con `workflows`, il motore
// "Automazioni v2" nativo del CMS (src/services/workflows.js) — due sistemi
// distinti, nome mapper "ghl-workflows" scelto apposta per non collidere.
// ─────────────────────────────────────────────────────────────────────────

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    // Slash finale come /calendars/ (vedi mappers/calendars.js): non
    // verificato di persona su questo endpoint, ma per coerenza con lo
    // stile REST osservato altrove su questa API teniamolo — se il
    // sorgente risponde 404 qui, il primo probe di verifica lo scopre
    // subito (log esplicito nel catch sotto, non un fallimento silenzioso).
    const res = await client.get("/workflows/", { locationId: cfg.location_id });
    const items = res?.workflows || res || [];
    addStat("ghl-workflows", "fetched", items.length);

    for (const w of items) {
      try {
        const externalId = w.id;
        if (!externalId) {
          addStat("ghl-workflows", "errors", 1);
          log(`ghl-workflow saltato: id mancante (${JSON.stringify(w).slice(0, 200)})`);
          continue;
        }

        const cols = {
          name: w.name || "",
          status: w.status || "",
          payload: JSON.stringify(w),
        };
        const timestamps = {};
        if (w.dateAdded || w.createdAt) timestamps.createdAt = w.dateAdded || w.createdAt;
        if (w.dateUpdated || w.updatedAt) timestamps.updatedAt = w.dateUpdated || w.updatedAt;

        if (dryRun) {
          addStat("ghl-workflows", "upserted", 1);
          continue;
        }

        const { action } = await upsertByExternalId({
          table: "ghl_workflows",
          siteId,
          externalId,
          cols,
          timestamps,
        });

        if (action === "inserted") addStat("ghl-workflows", "upserted", 1);
        else if (action === "updated") addStat("ghl-workflows", "updated", 1);
        else addStat("ghl-workflows", "skipped", 1);
      } catch (err) {
        addStat("ghl-workflows", "errors", 1);
        log(`ghl-workflow ${w.id}: ${err.message}`);
      }
    }
  } catch (err) {
    addStat("ghl-workflows", "errors", 1);
    log(`syncAll ghl-workflows fallito: ${err.message}`);
    throw err;
  }
}
