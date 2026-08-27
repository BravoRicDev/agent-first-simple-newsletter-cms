import { upsertByExternalId } from "../upsert.js";

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    // Doc CRM sorgente 2021-07-28 (Get Tags): l'endpoint reale è
    // GET /locations/:locationId/tags — locationId NEL PATH, non in query e
    // non su /tags/. La risposta è { tags: [ { id, name, locationId } ] }:
    // NESSUN campo "color", né "dateAdded"/"dateUpdated" (verificato sulle
    // pagine Get Tags / Create Tag / Get tag by id della doc 2021-07-28).
    const res = await client.get(`/locations/${cfg.location_id}/tags`);
    const tags = res?.tags || res || [];
    addStat("tags", "fetched", tags.length);

    for (const t of tags) {
      try {
        const externalId = t.id;
        if (!externalId || !t.name) {
          addStat("tags", "errors", 1);
          log(`tag saltato: id/name mancanti (${JSON.stringify(t)})`);
          continue;
        }

        const cols = {
          name: t.name,
          // 2021-07-28 NON espone "color" su GET /tags: il valore resta
          // sempre null finché l'API non lo restituisce. Lettura difensiva
          // per forward-compat, ma il campo non esiste nella versione usata.
          color: t.color || null,
        };

        // La risposta /tags NON include dateAdded/dateUpdated: non le
        // passiamo come timestamp del sorgente se assenti, così l'upsert
        // usa NOW(). Lo skip S4 per i tag è quindi inoperante quando il
        // sorgente non le restituisce (i tag vengono ri-toccati a ogni
        // sync). Se il sorgente le restituisse in futuro, le onoriamo.
        const timestamps = {};
        if (t.dateAdded) timestamps.createdAt = t.dateAdded;
        if (t.dateUpdated) timestamps.updatedAt = t.dateUpdated;

        if (dryRun) {
          addStat("tags", "upserted", 1);
          continue;
        }

        const { action } = await upsertByExternalId({
          table: "tags",
          siteId,
          externalId,
          cols,
          timestamps,
        });

        if (action === "inserted") addStat("tags", "upserted", 1);
        else if (action === "updated") addStat("tags", "updated", 1);
        else addStat("tags", "skipped", 1);
      } catch (err) {
        addStat("tags", "errors", 1);
        log(`tag ${t.id}: ${err.message}`);
      }
    }
  } catch (err) {
    addStat("tags", "errors", 1);
    log(`syncAll tags fallito: ${err.message}`);
    throw err;
  }
}
