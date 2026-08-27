import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";

export async function syncForContacts(ctx, extIds) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  if (!extIds?.length) return;

  try {
    for (const contactExtId of extIds) {
      try {
        // GET /opportunities/search (doc CRM sorgente 2021-07-28) usa nomi snake_case
        // per questi due parametri — a differenza di /contacts (camelCase
        // locationId). Verificato sulla doc ufficiale: contact_id/location_id,
        // non contactId/locationId.
        const oppsResp = await client.get("/opportunities/search", {
          contact_id: contactExtId,
          location_id: cfg.location_id
        });

        const opps = Array.isArray(oppsResp) ? oppsResp : oppsResp?.opportunities || [];
        addStat("opportunities", "fetched", opps.length);

        for (const opp of opps) {
          try {
            // Risolvi pipeline
            let pipelineId = null;
            if (opp.pipelineId) {
              pipelineId = await findInternalId("pipelines", siteId, opp.pipelineId);
            }

            // Risolvi stage: pipelineStageId → pipeline_stages.external_id → key
            // oppure lazy-create con key=label
            let stage = "";
            if (opp.pipelineStageId && pipelineId) {
              const stageRow = (await query(
                "SELECT key FROM pipeline_stages WHERE external_id=$1 AND pipeline_id=$2",
                [opp.pipelineStageId, pipelineId]
              )).rows[0];
              if (stageRow) {
                stage = stageRow.key;
              } else if (opp.stage) {
                const newStage = (await query(
                  `INSERT INTO pipeline_stages (pipeline_id, key, label, external_id)
                   VALUES ($1, $2, $2, $3)
                   ON CONFLICT (pipeline_id, key) DO UPDATE SET external_id=$3
                   RETURNING key`,
                  [pipelineId, opp.stage, opp.pipelineStageId]
                )).rows[0];
                stage = newStage?.key || "";
              }
            }

            // Risolvi owner. Verificato con una chiamata reale in produzione
            // (GET /opportunities/search live, 2026-08-26): assignedTo è una
            // stringa piatta (l'id utente), NON un oggetto {id}. opp.assignedTo?.id
            // era quindi sempre undefined — l'owner non veniva mai risolto.
            let ownerId = null;
            if (opp.assignedTo) {
              ownerId = await findInternalId("users", siteId, opp.assignedTo);
            }

            // Risolvi contact_email dal contatto locale
            let contactEmail = "";
            const contactRow = (await query(
              "SELECT email FROM contacts WHERE external_id=$1 AND site_id=$2",
              [contactExtId, siteId]
            )).rows[0];
            if (contactRow) {
              contactEmail = contactRow.email;
            }

            // Nomi campo verificati sulla risposta REALE (non solo doc, che
            // non li mostrava): createdAt/updatedAt (non dateAdded/dateUpdated),
            // lastStatusChangeAt (non lastStatusChange), lostReasonId — un id,
            // non un testo — (non lostReason), forecastProbability (non
            // probability), contact.name annidato (non contactName piatto).
            const cols = {
              title: opp.name || "",
              amount: opp.monetaryValue || 0,
              status: opp.status || "open",
              stage,
              pipeline_id: pipelineId,
              owner_id: ownerId,
              lost_reason: opp.lostReasonId || "",
              source: opp.source || "",
              last_status_change: opp.lastStatusChangeAt,
              expected_close_at: opp.forecastExpectedCloseDate,
              probability: opp.forecastProbability,
              contact_email: contactEmail,
              contact_name: opp.contact?.name || ""
            };

            const timestamps = {
              createdAt: opp.createdAt,
              updatedAt: opp.updatedAt
            };

            if (dryRun) {
              addStat("opportunities", "upserted", 1);
              continue;
            }

            const { action } = await upsertByExternalId({
              table: "opportunities",
              siteId,
              externalId: opp.id,
              cols,
              timestamps
            });

            if (action === "inserted") addStat("opportunities", "upserted", 1);
            else if (action === "updated") addStat("opportunities", "updated", 1);
            else addStat("opportunities", "skipped", 1);
          } catch (err) {
            addStat("opportunities", "errors", 1);
            log(`opportunity ${opp.id}: ${err.message}`);
          }
        }
      } catch (err) {
        addStat("opportunities", "errors", 1);
        log(`syncForContacts opportunities (${contactExtId}): ${err.message}`);
      }
    }
  } catch (err) {
    addStat("opportunities", "errors", 1);
    log(`syncForContacts opportunities fallito: ${err.message}`);
  }
}
