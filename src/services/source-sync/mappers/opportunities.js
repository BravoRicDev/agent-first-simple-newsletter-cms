import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";

/**
 * Helper: upserta singola opportunità dal CRM sorgente.
 * Usata sia da syncAll (globale) che da syncForContacts (per-contatto).
 */
async function upsertOpportunity(ctx, opp, contactGhlId = null) {
  const { siteId, dryRun, addStat, log } = ctx;

  // Resolve pipeline
  let pipelineId = null;
  if (opp.pipelineId) {
    pipelineId = await findInternalId("pipelines", siteId, opp.pipelineId);
  }

  // Resolve stage: pipelineStageId → pipeline_stages.ghl_id → key
  // oppure lazy-create con key=label
  let stage = "";
  if (opp.pipelineStageId && pipelineId) {
    const stageRow = (await query(
      "SELECT key FROM pipeline_stages WHERE ghl_id=$1 AND pipeline_id=$2",
      [opp.pipelineStageId, pipelineId]
    )).rows[0];
    if (stageRow) {
      stage = stageRow.key;
    } else if (opp.stage) {
      const newStage = (await query(
        `INSERT INTO pipeline_stages (pipeline_id, key, label, ghl_id)
         VALUES ($1, $2, $2, $3)
         ON CONFLICT (pipeline_id, key) DO UPDATE SET ghl_id=$3
         RETURNING key`,
        [pipelineId, opp.stage, opp.pipelineStageId]
      )).rows[0];
      stage = newStage?.key || "";
    }
  }

  // Resolve owner. Verificato con una chiamata reale in produzione
  // (GET /opportunities/search live, 2026-08-26): assignedTo è una
  // stringa piatta (l'id utente), NON un oggetto {id}.
  let ownerId = null;
  if (opp.assignedTo) {
    ownerId = await findInternalId("users", siteId, opp.assignedTo);
  }

  // Risolvi contact_email dal contatto locale.
  // contactGhlId può arrivare dal chiamante (syncForContacts conosce già
  // l'id contatto) oppure dal campo opp.contactId / opp.contact?.id
  // (syncAll globale).
  let contactEmail = "";
  const resolvedContactId = contactGhlId || opp.contactId || opp.contact?.id || null;
  if (resolvedContactId) {
    const contactRow = (await query(
      "SELECT email FROM contacts WHERE ghl_id=$1 AND site_id=$2",
      [resolvedContactId, siteId]
    )).rows[0];
    if (contactRow) {
      contactEmail = contactRow.email;

      // Discovery: se il contatto non è ancora noto localmente, segnalalo
      // per il fetch successivo (stesso pattern di forms.js).
      if (!ctx.knownContacts?.has(resolvedContactId)) {
        ctx.discoveredContacts?.add(resolvedContactId);
      }
    }
  }

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
    probability: opp.forecastProbability ?? 0,
    contact_email: contactEmail,
    contact_name: opp.contact?.name || ""
  };

  const timestamps = {
    createdAt: opp.createdAt,
    updatedAt: opp.updatedAt
  };

  if (dryRun) {
    addStat("opportunities", "upserted", 1);
    return;
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
}

/**
 * Sync globale: scarica TUTTE le opportunità della location via
 * POST /opportunities/search (locationId camelCase, senza contact_id).
 * Paginazione cursore (searchAfter) con pageLimit=100.
 * Mantiene syncForContacts esistente per la caccia per-contatto.
 */
export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    const PAGE_LIMIT = 100;
    let searchAfter = null;
    let fetched = 0;
    let pages = 0;

    for (;;) {
      if (pages >= 10000) {
        log(`syncAll opportunities: MAX_PAGES raggiunto`);
        break;
      }

      const body = { locationId: cfg.location_id, pageLimit: PAGE_LIMIT };
      if (searchAfter) body.searchAfter = searchAfter;

      const res = await client.raw("/opportunities/search", {
        method: "POST",
        body,
        sendLocationId: false,
      });

      const opps = Array.isArray(res) ? res : res?.opportunities || [];
      if (opps.length === 0) break;

      pages++;
      fetched += opps.length;
      addStat("opportunities", "fetched", opps.length);

      for (const opp of opps) {
        try {
          await upsertOpportunity(ctx, opp);
        } catch (err) {
          addStat("opportunities", "errors", 1);
          log(`opportunity ${opp.id}: ${err.message}`);
        }
      }

      // Stop se abbiamo raggiunto il totale o l'ultima pagina
      const total = Number.isFinite(res?.total) ? res.total : null;
      if (total !== null && fetched >= total) break;
      if (opps.length < PAGE_LIMIT) break;

      // Cursore per la pagina successiva. ATTENZIONE: il campo cursore
      // nella RISPOSTA di ogni opportunità si chiama "sort" (verificato dal
      // vivo su GHL reale: {"opportunities":[{... "sort":[ts,id] ...}]}),
      // NON "searchAfter" come invece è il nome del parametro da rimandare
      // nella richiesta della pagina successiva. Nomi diversi per lo stesso
      // concetto (pattern search_after stile Elasticsearch): leggere
      // last.searchAfter qui sarebbe sempre undefined e fermerebbe la
      // paginazione dopo la prima pagina, ogni volta.
      const last = opps[opps.length - 1];
      if (!last?.sort) break;
      searchAfter = last.sort;
    }
  } catch (err) {
    addStat("opportunities", "errors", 1);
    log(`syncAll opportunities fallito: ${err.message}`);
    throw err;
  }
}

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
        // sendLocationId:false — client.js aggiunge SEMPRE anche un locationId
        // (camelCase) di default: l'endpoint vede ENTRAMBI i parametri insieme
        // e rifiuta con 422 "property locationId should not exist", anche con
        // location_id (quello giusto, snake_case) presente e corretto.
        // Verificato dal vivo: 100% di fallimento su ogni contatto, nessuna
        // opportunità mai sincronizzata da quando esiste questo modulo, prima
        // di questo fix (bug mai emerso perché "opportunities" non è
        // in SWEEP_ORDER — parte solo da huntSubresources durante un giro
        // contatti completo, mai coperta da un run scoped su risorse singole).
        const oppsResp = await client.get("/opportunities/search", {
          contact_id: contactExtId,
          location_id: cfg.location_id
        }, { sendLocationId: false });

        const opps = Array.isArray(oppsResp) ? oppsResp : oppsResp?.opportunities || [];
        addStat("opportunities", "fetched", opps.length);

        for (const opp of opps) {
          try {
            await upsertOpportunity(ctx, opp, contactExtId);
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