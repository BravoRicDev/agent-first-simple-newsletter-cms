import { upsertByExternalId } from "../upsert.js";

// ─────────────────────────────────────────────────────────────────────────
// Funnel del CRM sorgente (GET /funnels/funnel/list): nome + step di pagina
// in JSONB — struttura ricca e nidificata copiata integrale invece di
// modellata relazionalmente. Tabella ghl_funnels.
//
// Nota tecnica verificata dal vivo: l'id della risorsa è `_id`, NON `id`
// come su quasi tutte le altre risorse di questa API — e i timestamp sono
// dateAdded/dateUpdated (non createdAt/updatedAt come opportunities/altri).
// ─────────────────────────────────────────────────────────────────────────

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    const res = await client.get("/funnels/funnel/list", { locationId: cfg.location_id });
    const items = res?.funnels || res || [];
    addStat("funnels", "fetched", items.length);

    for (const f of items) {
      try {
        // ATTENZIONE: _id, non id (diverso dal resto dell'API).
        const externalId = f._id;
        if (!externalId) {
          addStat("funnels", "errors", 1);
          log(`funnel saltato: _id mancante (${JSON.stringify(f).slice(0, 200)})`);
          continue;
        }

        const cols = {
          name: f.name || "",
          steps: JSON.stringify(f.steps || f),
        };
        const timestamps = {};
        if (f.dateAdded) timestamps.createdAt = f.dateAdded;
        if (f.dateUpdated) timestamps.updatedAt = f.dateUpdated;

        if (dryRun) {
          addStat("funnels", "upserted", 1);
          continue;
        }

        const { action } = await upsertByExternalId({
          table: "ghl_funnels",
          siteId,
          externalId,
          cols,
          timestamps,
        });

        if (action === "inserted") addStat("funnels", "upserted", 1);
        else if (action === "updated") addStat("funnels", "updated", 1);
        else addStat("funnels", "skipped", 1);
      } catch (err) {
        addStat("funnels", "errors", 1);
        log(`funnel ${f._id}: ${err.message}`);
      }
    }
  } catch (err) {
    addStat("funnels", "errors", 1);
    log(`syncAll funnels fallito: ${err.message}`);
    throw err;
  }
}
