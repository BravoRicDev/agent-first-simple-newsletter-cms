import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";

function slugify(label) {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    const res = await client.get("/opportunities/pipelines");
    const pipelines = res?.pipelines || res || [];
    addStat("pipelines", "fetched", pipelines.length);

    for (const p of pipelines) {
      try {
        // Stage "name" verificato sulla doc CRM sorgente 2021-07-28 (Create/Get Pipeline):
        // gli stadi espongono "name" (es. { name, position }), NON "label" né
        // "key". "key" non esiste nella risposta CRM sorgente — è una chiave locale
        // stabile che deriviamo dallo slug del nome (fallback stage_<i>).
        const stageNameOf = (s, i) => s.name || s.label || `stage_${i}`;
        const cols = {
          name: p.name,
          stages: JSON.stringify(
            (p.stages || []).map((s, i) => {
              const nm = stageNameOf(s, i);
              return { key: s.key || slugify(nm), label: nm };
            })
          ),
          is_default: false,
        };
        // ⚠️ Parità CRM sorgente 2021-07-28 NON documentata: la risposta pipeline
        // (schema get-pipeline) non elenca dateAdded/dateUpdated. Li leggiamo
        // in modo difensivo — se il sorgente non li restituisce restano null
        // e upsertByExternalId usa NOW(). Da verificare con dati live.
        const timestamps = {
          createdAt: p.dateAdded,
          updatedAt: p.dateUpdated,
        };

        if (dryRun) {
          addStat("pipelines", "upserted", 1);
          continue;
        }

        const { row: pipelineRow, action: pAction } = await upsertByExternalId({
          table: "pipelines",
          siteId,
          externalId: p.id,
          cols,
          timestamps,
        });

        if (pAction === "inserted") addStat("pipelines", "upserted", 1);
        else if (pAction === "updated") addStat("pipelines", "updated", 1);
        else addStat("pipelines", "skipped", 1);

        // Crea le righe pipeline_stages
        const stages = p.stages || [];
        for (let i = 0; i < stages.length; i++) {
          const s = stages[i];
          try {
            // Doc CRM sorgente 2021-07-28: lo stadio espone "name" (non "label"). La
            // "key" non esiste in risposta — la deriviamo dallo slug del nome.
            const stageName = s.name || s.label || `stage_${i}`;
            const stageKey = s.key || slugify(stageName);
            const stageCols = {
              key: stageKey,
              label: stageName,
              color: s.color || "",
              position: typeof s.position === "number" ? s.position : i,
            };
            const stageTimestamps = {
              createdAt: s.dateAdded,
              updatedAt: s.dateUpdated,
            };

            if (!dryRun) {
              await upsertByExternalId({
                table: "pipeline_stages",
                siteId,
                externalId: s.id,
                cols: { ...stageCols, pipeline_id: pipelineRow.id },
                timestamps: stageTimestamps,
              });
            }
          } catch (err) {
            log(`pipeline_stage ${s.id}: ${err.message}`);
          }
        }
      } catch (err) {
        addStat("pipelines", "errors", 1);
        log(`pipeline ${p.id}: ${err.message}`);
      }
    }
  } catch (err) {
    addStat("pipelines", "errors", 1);
    log(`syncAll pipelines fallito: ${err.message}`);
    throw err;
  }
}
