import { upsertByExternalId } from "../upsert.js";

// ─────────────────────────────────────────────────────────────────────────
// Custom Values di location (GET /locations/{locationId}/customValues):
// concetto DISTINTO dai Custom Fields per-contatto (tabella custom_fields,
// già sincronizzati da mappers/custom-fields.js) — sono merge tag globali
// del sito/location, usati in template/workflow del CRM sorgente, NON
// legati a un singolo contatto. Tabella ghl_custom_values.
// ─────────────────────────────────────────────────────────────────────────

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    // sendLocationId:false — locationId già nel path, stesso motivo di
    // custom-fields.js/tags.js (422 "property locationId should not exist"
    // su alcuni endpoint /locations/{id}/... gemelli).
    const res = await client.get(`/locations/${cfg.location_id}/customValues`, {}, { sendLocationId: false });
    const items = res?.customValues || res || [];
    addStat("custom-values", "fetched", items.length);

    for (const cv of items) {
      try {
        const externalId = cv.id;
        if (!externalId) {
          addStat("custom-values", "errors", 1);
          log(`custom-value saltato: id mancante (${JSON.stringify(cv).slice(0, 200)})`);
          continue;
        }

        const cols = {
          name: cv.name || "",
          value: cv.value || "",
        };

        if (dryRun) {
          addStat("custom-values", "upserted", 1);
          continue;
        }

        const { action } = await upsertByExternalId({
          table: "ghl_custom_values",
          siteId,
          externalId,
          cols,
        });

        if (action === "inserted") addStat("custom-values", "upserted", 1);
        else if (action === "updated") addStat("custom-values", "updated", 1);
        else addStat("custom-values", "skipped", 1);
      } catch (err) {
        addStat("custom-values", "errors", 1);
        log(`custom-value ${cv.id}: ${err.message}`);
      }
    }
  } catch (err) {
    addStat("custom-values", "errors", 1);
    log(`syncAll custom-values fallito: ${err.message}`);
    throw err;
  }
}
