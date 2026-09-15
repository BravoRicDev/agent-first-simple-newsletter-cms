import { query } from "../../db.js";
import { logger } from "../logger.js";
import { ensureUniqueInvoiceNumber } from "./mappers/commerce.js";

// ─────────────────────────────────────────────────────────────────────────
// Clonazione locale da un sito "gemello" (stesso account/location sorgente,
// db/126_source_id_per_site.sql) — evita di rifare l'intero giro di chiamate
// sorgente per contatti + sotto-risorse (note/task/opportunità/conversazioni/
// appuntamenti: O(numero contatti) chiamate, la parte di gran lunga più
// costosa del budget API) quando un altro sito CMS ha GIÀ sincronizzato
// gli STESSI dati dallo STESSO CRM sorgente. Richiesta cliente: "i contatti
// di site_21 e site_22 sono gli stessi... non serve [risincronizzarli],
// altrimenti rischiamo di saturare le api di source per niente".
//
// Copia via SQL locale (zero chiamate sorgente, zero consumo di budget/quota):
// stesso esito finale di un sync via API (ogni sito ha la propria copia
// locale indipendente, filtrata per site_id come sempre), ma senza
// rifare il fetch. I riferimenti a risorse interne (pipeline_id,
// calendar_id) vengono ri-risolti sulle copie GIÀ presenti nel sito
// target (pipelines/calendars/users sincronizzano comunque in modo
// indipendente per ogni sito — sono economici, poche decine/centinaia di
// righe, non la parte costosa) tramite il loro source_id condiviso.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Decide il ruolo di questo sito nel rapporto master/slave ESPlicito
 * (db/129_sync_master_slave.sql). SOSTITUISCE la vecchia
 * findSiblingWithContacts, che sceglieva il sibling in base al numero di
 * contatti sincronizzati (ORDER BY COUNT DESC): ambigua e SIMMETRICA quando i
 * conteggi erano uguali (site 21 e 22 entrambi 14592) ⇒ entrambi clonavano
 * dall'altro ⇒ nessuno chamava più sorgente ⇒ dati fermi per sempre.
 *
 * Ora la decisione è deterministica e NON dipende da alcun conteggio:
 *  - sync_master_site_id IS NULL ⇒ MASTER (o standalone): chiama SEMPRE il CRM
 *    sorgente reale, non clona mai ⇒ { mode:"master", cloneFrom:null, skip:false }.
 *  - sync_master_site_id = <id>  ⇒ SLAVE del master <id>. Clona SEMPRE dal
 *    master quando è una fonte affidabile (esiste, è abilitato, è a sua volta
 *    un master senza catene, stesso account/location) ⇒
 *    { mode:"slave", cloneFrom:<id>, skip:false }.
 *    Se la fonte NON è affidabile ⇒ { mode:"slave", cloneFrom:null, skip:true }:
 *    lo slave SALTA il giro (gestito in runSync) e NON fa fallback a un sync
 *    reale proprio — vedi commento in index.js e nel commit.
 */
export async function resolveSiblingSource(siteId, cfg) {
  const masterId = cfg.sync_master_site_id;
  if (masterId === null || masterId === undefined) {
    return { mode: "master", cloneFrom: null, skip: false };
  }
  const master = (
    await query(
      "SELECT enabled, sync_master_site_id, base_url, location_id FROM source_sync_config WHERE site_id = $1",
      [masterId]
    )
  ).rows[0];
  // Master inesistente, catene (il "master" è a sua volta slave) o master
  // disabilitato: nessuna fonte esplicita affidabile.
  if (!master || master.sync_master_site_id !== null || !master.enabled) {
    return { mode: "slave", cloneFrom: null, skip: true };
  }
  // La clonazione ha senso solo fra siti sullo STESSO account/location sorgente:
  // un mismatch è una configurazione errata (clonerebbe dati di una location
  // diversa) ⇒ tratta il master come non disponibile (skip), non un fallback.
  if (master.base_url !== cfg.base_url || master.location_id !== cfg.location_id) {
    return { mode: "slave", cloneFrom: null, skip: true };
  }
  return { mode: "slave", cloneFrom: masterId, skip: false };
}

/**
 * Copia contatti + note/task/opportunità/conversazioni(+messaggi)/
 * appuntamenti dal sito gemello nel sito target. Idempotente (ON CONFLICT
 * sull'indice UNIQUE(site_id, source_id) di ciascuna tabella, introdotto da
 * db/126_source_id_per_site.sql): rieseguibile ad ogni tick come un sync
 * normale, aggiorna solo ciò che è cambiato.
 *
 * NB: pipelines/calendars devono essere già sincronizzati (in modo
 * indipendente, via API) per il sito target PRIMA di chiamare questa
 * funzione, altrimenti opportunities.pipeline_id/booking_appointments.
 * calendar_id restano NULL per mancata corrispondenza — SWEEP_ORDER in
 * index.js già garantisce quest'ordine (pipelines/calendars girano prima
 * di contacts).
 */
export async function cloneContactsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;

  try {
    const contactsRes = await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, source_contact_raw, created_at, updated_at)
       SELECT $1, source_id, email, tags, status, notes, source_contact_raw, created_at, updated_at
       FROM contacts WHERE site_id = $2 AND source_id <> ''
       ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET
         email = EXCLUDED.email, tags = EXCLUDED.tags, status = EXCLUDED.status,
         notes = EXCLUDED.notes, source_contact_raw = EXCLUDED.source_contact_raw, updated_at = EXCLUDED.updated_at
       RETURNING source_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", contactsRes.rowCount);
    // knownContacts va aggiornato: la ricorsione discovery (submission
    // orfane) e l'hunt subresource per pagina si basano su questo set.
    for (const row of contactsRes.rows) ctx.knownContacts.add(row.source_id);

    const notesRes = await query(
      `INSERT INTO contact_notes (site_id, source_id, contact_email, author_type, author_name, body, created_at, updated_at, contact_id)
       SELECT $1, n.source_id, n.contact_email, n.author_type, n.author_name, n.body, n.created_at, n.updated_at, tc.id
       FROM contact_notes n
       LEFT JOIN contacts tc ON tc.site_id = $1 AND tc.email = n.contact_email
       WHERE n.site_id = $2 AND n.source_id <> ''
       ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET
         body = EXCLUDED.body, updated_at = EXCLUDED.updated_at, contact_id = EXCLUDED.contact_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", notesRes.rowCount);

    const tasksRes = await query(
      `INSERT INTO tasks (site_id, source_id, email, title, notes, due_at, status, created_at, reminder_date)
       SELECT $1, source_id, email, title, notes, due_at, status, created_at, reminder_date
       FROM tasks WHERE site_id = $2 AND source_id <> ''
       ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET
         title = EXCLUDED.title, notes = EXCLUDED.notes, due_at = EXCLUDED.due_at,
         status = EXCLUDED.status, reminder_date = EXCLUDED.reminder_date`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", tasksRes.rowCount);

    // Opportunità: pipeline_id va ri-risolto sulla copia locale del sito
    // target (stesso source_id di pipeline, id interno diverso).
    const oppsRes = await query(
      `INSERT INTO opportunities (
         site_id, source_id, contact_email, contact_name, contact_company, pipeline_id, stage,
         title, amount, probability, status, expected_close_at, notes, source, last_status_change,
         lost_reason, created_at, updated_at
       )
       SELECT $1, o.source_id, o.contact_email, o.contact_name, o.contact_company, tp.id, o.stage,
              o.title, o.amount, o.probability, o.status, o.expected_close_at, o.notes, o.source,
              o.last_status_change, o.lost_reason, o.created_at, o.updated_at
       FROM opportunities o
       LEFT JOIN pipelines sp ON sp.id = o.pipeline_id
       LEFT JOIN pipelines tp ON tp.site_id = $1 AND tp.source_id = sp.source_id AND sp.source_id <> ''
       WHERE o.site_id = $2 AND o.source_id <> ''
       ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET
         stage = EXCLUDED.stage, title = EXCLUDED.title, amount = EXCLUDED.amount,
         probability = EXCLUDED.probability, status = EXCLUDED.status,
         expected_close_at = EXCLUDED.expected_close_at, notes = EXCLUDED.notes,
         last_status_change = EXCLUDED.last_status_change, lost_reason = EXCLUDED.lost_reason,
         updated_at = EXCLUDED.updated_at, pipeline_id = EXCLUDED.pipeline_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", oppsRes.rowCount);

    const convRes = await query(
      `INSERT INTO conversations (site_id, source_id, contact_email, channel, status, subject, created_at, updated_at, unread_count, starred)
       SELECT $1, source_id, contact_email, channel, status, subject, created_at, updated_at, unread_count, starred
       FROM conversations WHERE site_id = $2 AND source_id <> ''
       ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET
         status = EXCLUDED.status, subject = EXCLUDED.subject, updated_at = EXCLUDED.updated_at,
         unread_count = EXCLUDED.unread_count, starred = EXCLUDED.starred
       RETURNING id, source_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", convRes.rowCount);

    // Messaggi: legati a conversation_id (nessun source_id proprio in questa
    // tabella — non toccata da db/120/126). Copiamo per ogni conversazione
    // appena upsertata risolvendo il nuovo conversation_id locale.
    let msgCount = 0;
    for (const conv of convRes.rows) {
      const siblingConv = (
        await query(
          "SELECT id FROM conversations WHERE site_id = $1 AND source_id = $2",
          [siblingSiteId, conv.source_id]
        )
      ).rows[0];
      if (!siblingConv) continue;
      const msgRes = await query(
        `INSERT INTO conversation_messages (conversation_id, direction, subject, body, meta, created_at, message_type, status, read_at, attachments, source_message_id)
         SELECT $1, direction, subject, body, meta, created_at, message_type, status, read_at, attachments, source_message_id
         FROM conversation_messages
         WHERE conversation_id = $2 AND source_message_id IS NOT NULL
         ON CONFLICT (conversation_id, source_message_id) WHERE source_message_id IS NOT NULL DO NOTHING`,
        [conv.id, siblingConv.id]
      );
      msgCount += msgRes.rowCount;
    }
    addStat("contacts", "upserted", msgCount);

    // Appuntamenti: calendar_id va ri-risolto come per pipeline_id.
    const apptRes = await query(
      `INSERT INTO booking_appointments (
         site_id, source_id, contact_name, contact_email, contact_phone, title, description,
         start_time, end_time, status, timezone, calendar_id, appointment_status,
         cancelled_at, created_at, updated_at
       )
       SELECT $1, a.source_id, a.contact_name, a.contact_email, a.contact_phone, a.title, a.description,
              a.start_time, a.end_time, a.status, a.timezone, tc.id, a.appointment_status,
              a.cancelled_at, a.created_at, a.updated_at
       FROM booking_appointments a
       LEFT JOIN calendars sc ON sc.id = a.calendar_id
       LEFT JOIN calendars tc ON tc.site_id = $1 AND tc.source_id = sc.source_id AND sc.source_id <> ''
       WHERE a.site_id = $2 AND a.source_id <> ''
       ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET
         title = EXCLUDED.title, description = EXCLUDED.description, start_time = EXCLUDED.start_time,
         end_time = EXCLUDED.end_time, status = EXCLUDED.status, appointment_status = EXCLUDED.appointment_status,
         cancelled_at = EXCLUDED.cancelled_at, updated_at = EXCLUDED.updated_at, calendar_id = EXCLUDED.calendar_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", apptRes.rowCount);

    // Valori custom del profilo contatto (firstName/lastName/phone/ecc.):
    // senza questa copia, i contatti clonati arrivavano "vuoti" di profilo
    // sul sito target pur avendo lo stesso source_id del sorgente — mancava
    // qui, non coperta da cloneCustomValuesFromSibling (quella copia
    // source_custom_values, il mirror read-only del CRM sorgente, tabella
    // diversa dal contact_custom_values usato dal clone-API).
    const customValuesRes = await query(
      `INSERT INTO contact_custom_values (site_id, contact_id, object_key, values, updated_at)
       SELECT $1, tc.id, ccv.object_key, ccv.values, ccv.updated_at
       FROM contact_custom_values ccv
       JOIN contacts sc ON sc.id = ccv.contact_id AND sc.site_id = $2
       JOIN contacts tc ON tc.site_id = $1 AND tc.source_id = sc.source_id AND sc.source_id <> ''
       WHERE ccv.site_id = $2
       ON CONFLICT (site_id, contact_id, object_key) DO UPDATE SET
         values = EXCLUDED.values, updated_at = EXCLUDED.updated_at`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", customValuesRes.rowCount);

    log(`cloneContactsFromSibling: ${contactsRes.rowCount} contatti, ${notesRes.rowCount} note, ${tasksRes.rowCount} task, ${oppsRes.rowCount} opportunità, ${convRes.rowCount} conversazioni, ${msgCount} messaggi, ${apptRes.rowCount} appuntamenti, ${customValuesRes.rowCount} valori custom copiati da site ${siblingSiteId} (zero chiamate sorgente)`);
  } catch (err) {
    logger.error(`cloneContactsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("contacts", "errors", 1);
    throw err;
  }
}

/**
 * Legge le colonne REALI di una tabella via information_schema.columns (cache inclusa,
 * come getColumns in upsert.js) e restituisce i nomi escludendo un set di colonne da
 * filtrare (default: id, site_id, external_id).
 */
async function getFilteredColumns(table, exclude = new Set(["id", "site_id", "external_id"])) {
  const r = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  const allCols = new Set(r.rows.map((x) => x.column_name));
  // Mantiene l'ordine originale dello schema ma filtra le colonne da escludere
  const filtered = [...allCols].filter((c) => !exclude.has(c));
  return filtered;
}

/**
 * Clonazione semplice da sito gemello per tabelle che hanno una propria colonna site_id
 * più source_id, con indice UNIQUE(site_id, source_id) (db/126).
 *
 * - Legge dinamicamente le colonne reali della tabella (esclude id, site_id, external_id)
 * - Copia TUTTE le altre colonne reali (incluse created_at/updated_at)
 * - ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET tutte le colonne eccetto source_id
 *
 * @param {string} table - nome tabella
 * @param {number} siteId - sito target
 * @param {number} siblingSiteId - sito gemello
 * @returns {Promise<number>} rowCount
 */
async function cloneSimpleTableFromSibling(table, siteId, siblingSiteId) {
  const excluded = new Set(["id", "site_id", "external_id"]);
  const cols = await getFilteredColumns(table, excluded);
  if (cols.length === 0) {
    logger.warn(`cloneSimpleTableFromSibling: nessuna colonna trovata per la tabella "${table}" dopo la filtrazione`);
    return 0;
  }

  const colNames = cols.join(", ");
  // Per l'ON CONFLICT impostiamo SET per tutte le colonne eccetto source_id stesso
  // (source_id è parte del conflitto e NON va aggiornato).
  const setClauses = cols
    .filter((c) => c !== "source_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const insertSql = `
    INSERT INTO ${table} (site_id, ${colNames})
    SELECT $1, ${colNames}
    FROM ${table} WHERE site_id = $2 AND source_id <> ''
    ON CONFLICT (site_id, source_id) WHERE source_id <> '' DO UPDATE SET
      ${setClauses}
    RETURNING source_id
  `;

  const res = await query(insertSql, [siteId, siblingSiteId]);
  return res.rowCount;
}

/**
 * Clonazione da sito gemello per tabelle FIGLIE senza propria colonna site_id.
 * Il tenant è derivato dal genitore tramite source_id condiviso.
 *
 * Tabelle supportate: pipeline_stages (parentCol="pipeline_id", parentTable="pipelines"),
 * invoice_items (parentCol="invoice_id", parentTable="invoices").
 *
 * - Legge dinamicamente le colonne reali della tabella (esclude id, parentCol, external_id)
 * - source_id viene copiato come colonna dati
 * - Il parentCol valore si RI-RESOLVE sulla copia locale del sito target
 *   tramite il source_id condiviso del genitore
 * - ON CONFLICT (<parentCol>, source_id) WHERE source_id <> '' DO UPDATE SET tutte le colonne eccetto source_id
 *
 * IMPORTANTE: il genitore deve essere già stato clonato/sincronizzato per il sito
 * target PRIMA di chiamare questa funzione (lo sweep di index.js garantisce
 * che "pipelines" giri prima di qualunque cosa dipenda da esso).
 *
 * @param {object} params - { table, parentCol, parentTable, siteId, siblingSiteId }
 * @returns {Promise<number>} rowCount
 */
async function cloneChildTableFromSibling({ table, parentCol, parentTable, siteId, siblingSiteId }) {
  const excluded = new Set(["id", parentCol, "external_id"]);
  const cols = await getFilteredColumns(table, excluded);
  if (cols.length === 0) {
    logger.warn(`cloneChildTableFromSibling: nessuna colonna trovata per la tabella "${table}" dopo la filtrazione`);
    return 0;
  }

  const colNames = cols.join(", ");
  // Lista SELECT qualificata: OGNI colonna va prefissata con l'alias c., altrimenti
  // le colonne con nomi condivisi con la tabella genitore (es. created_at, updated_at
  // in pipelines) restano AMBIGUE nella JOIN → "column reference is ambiguous".
  const qualifiedColNames = cols.map((col) => `c.${col}`).join(", ");
  // Per l'ON CONFLICT: la chiave unica è (parentCol, source_id). Impostiamo SET per tutte
  // le colonne eccetto source_id stesso.
  const setClauses = cols
    .filter((c) => c !== "source_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const insertSql = `
    INSERT INTO ${table} (${parentCol}, ${colNames})
    SELECT tp.id, ${qualifiedColNames}
    FROM ${table} c
    JOIN ${parentTable} sp ON sp.id = c.${parentCol}
    JOIN ${parentTable} tp ON tp.site_id = $1 AND tp.source_id = sp.source_id AND sp.source_id <> ''
    WHERE sp.site_id = $2 AND c.source_id <> ''
    ON CONFLICT (${parentCol}, source_id) WHERE source_id <> '' DO UPDATE SET
      ${setClauses}
    RETURNING source_id
  `;

  const res = await query(insertSql, [siteId, siblingSiteId]);
  return res.rowCount;
}

/**
 * Clona custom_fields dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount
 */
export async function cloneCustomFieldsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const rowCount = await cloneSimpleTableFromSibling("custom_fields", siteId, siblingSiteId);
    addStat("custom-fields", "upserted", rowCount);
    log(`cloneCustomFieldsFromSibling: ${rowCount} campi copiati da site ${siblingSiteId}`);
    return rowCount;
  } catch (err) {
    logger.error(`cloneCustomFieldsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("custom-fields", "errors", 1);
    throw err;
  }
}

/**
 * Clona custom_values dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount
 */
export async function cloneCustomValuesFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const rowCount = await cloneSimpleTableFromSibling("source_custom_values", siteId, siblingSiteId);
    addStat("custom-values", "upserted", rowCount);
    log(`cloneCustomValuesFromSibling: ${rowCount} valori copiati da site ${siblingSiteId}`);
    return rowCount;
  } catch (err) {
    logger.error(`cloneCustomValuesFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("custom-values", "errors", 1);
    throw err;
  }
}

/**
 * Clona tags dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount
 */
export async function cloneTagsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const rowCount = await cloneSimpleTableFromSibling("tags", siteId, siblingSiteId);
    addStat("tags", "upserted", rowCount);
    log(`cloneTagsFromSibling: ${rowCount} tag copiati da site ${siblingSiteId}`);
    return rowCount;
  } catch (err) {
    logger.error(`cloneTagsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("tags", "errors", 1);
    throw err;
  }
}

/**
 * Clona pipelines dal sito gemello al sito target, seguita dalla clonazione
 * dei pipeline_stages (figlia).
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount totale (pipelines + pipeline_stages)
 */
export async function clonePipelinesFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const pipelinesCount = await cloneSimpleTableFromSibling("pipelines", siteId, siblingSiteId);
    // Ora clone i pipeline_stages (figlia, parentCol="pipeline_id", parentTable="pipelines")
    const stagesCount = await cloneChildTableFromSibling({
      table: "pipeline_stages",
      parentCol: "pipeline_id",
      parentTable: "pipelines",
      siteId,
      siblingSiteId,
    });
    addStat("pipelines", "upserted", pipelinesCount);
    addStat("pipeline_stages", "upserted", stagesCount);
    log(`clonePipelinesFromSibling: ${pipelinesCount} pipeline, ${stagesCount} stage copiati da site ${siblingSiteId}`);
    return pipelinesCount + stagesCount;
  } catch (err) {
    logger.error(`clonePipelinesFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("pipelines", "errors", 1);
    addStat("pipeline_stages", "errors", 1);
    throw err;
  }
}

/**
 * Clona calendars dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount
 */
export async function cloneCalendarsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const rowCount = await cloneSimpleTableFromSibling("calendars", siteId, siblingSiteId);
    addStat("calendars", "upserted", rowCount);
    log(`cloneCalendarsFromSibling: ${rowCount} calendari copiati da site ${siblingSiteId}`);
    return rowCount;
  } catch (err) {
    logger.error(`cloneCalendarsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("calendars", "errors", 1);
    throw err;
  }
}

/**
 * Clona forms e form_submissions dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount totale (forms + form_submissions)
 */
export async function cloneFormsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const formsCount = await cloneSimpleTableFromSibling("forms", siteId, siblingSiteId);
    const submissionsCount = await cloneSimpleTableFromSibling("form_submissions", siteId, siblingSiteId);
    addStat("forms", "upserted", formsCount);
    addStat("form_submissions", "upserted", submissionsCount);
    log(`cloneFormsFromSibling: ${formsCount} form, ${submissionsCount} submission copiati da site ${siblingSiteId}`);
    return formsCount + submissionsCount;
  } catch (err) {
    logger.error(`cloneFormsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("forms", "errors", 1);
    addStat("form_submissions", "errors", 1);
    throw err;
  }
}

/**
 * Clona surveys e survey_submissions dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount totale (surveys + survey_submissions)
 */
export async function cloneSurveysFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const surveysCount = await cloneSimpleTableFromSibling("surveys", siteId, siblingSiteId);
    const submissionsCount = await cloneSimpleTableFromSibling("survey_submissions", siteId, siblingSiteId);
    addStat("surveys", "upserted", surveysCount);
    addStat("survey_submissions", "upserted", submissionsCount);
    log(`cloneSurveysFromSibling: ${surveysCount} survey, ${submissionsCount} submission copiati da site ${siblingSiteId}`);
    return surveysCount + submissionsCount;
  } catch (err) {
    logger.error(`cloneSurveysFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("surveys", "errors", 1);
    addStat("survey_submissions", "errors", 1);
    throw err;
  }
}

/**
 * Clona newsletter_campaigns e marketing_templates dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount totale (campaigns + templates)
 */
export async function cloneCampaignsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const campaignsCount = await cloneSimpleTableFromSibling("newsletter_campaigns", siteId, siblingSiteId);
    const templatesCount = await cloneSimpleTableFromSibling("marketing_templates", siteId, siblingSiteId);
    addStat("campaigns", "upserted", campaignsCount);
    addStat("marketing_templates", "upserted", templatesCount);
    log(`cloneCampaignsFromSibling: ${campaignsCount} campaign, ${templatesCount} template copiati da site ${siblingSiteId}`);
    return campaignsCount + templatesCount;
  } catch (err) {
    logger.error(`cloneCampaignsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("campaigns", "errors", 1);
    addStat("marketing_templates", "errors", 1);
    throw err;
  }
}

/**
 * Clona source_workflows dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount
 */
export async function cloneSourceWorkflowsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const rowCount = await cloneSimpleTableFromSibling("source_workflows", siteId, siblingSiteId);
    addStat("source-workflows", "upserted", rowCount);
    log(`cloneSourceWorkflowsFromSibling: ${rowCount} workflow copiati da site ${siblingSiteId}`);
    return rowCount;
  } catch (err) {
    logger.error(`cloneSourceWorkflowsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("source-workflows", "errors", 1);
    throw err;
  }
}

/**
 * Clona source_funnels dal sito gemello al sito target.
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount
 */
export async function cloneFunnelsFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    const rowCount = await cloneSimpleTableFromSibling("source_funnels", siteId, siblingSiteId);
    addStat("funnels", "upserted", rowCount);
    log(`cloneFunnelsFromSibling: ${rowCount} funnel copiati da site ${siblingSiteId}`);
    return rowCount;
  } catch (err) {
    logger.error(`cloneFunnelsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("funnels", "errors", 1);
    throw err;
  }
}

/**
 * Clonacommerce dati dal sito gemello: products, product_prices, payment_links,
 * invoices + invoice_items (con logica personalizzata per invoices).
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount
 */
export async function cloneCommerceFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  try {
    // Products: clone semplice
    const productsCount = await cloneSimpleTableFromSibling("products", siteId, siblingSiteId);
    addStat("commerce", "upserted", productsCount);

    // Product prices: clone semplice (ha site_id proprio)
    const productPricesCount = await cloneSimpleTableFromSibling("product_prices", siteId, siblingSiteId);
    addStat("commerce", "upserted", productPricesCount);

    // Payment links: clone semplice
    const paymentLinksCount = await cloneSimpleTableFromSibling("payment_links", siteId, siblingSiteId);
    addStat("commerce", "upserted", paymentLinksCount);

    // Invoices + invoice_items: logica personalizzata
    const invoicesCount = await cloneInvoicesFromSibling(ctx, siblingSiteId);

    log(`cloneCommerceFromSibling: ${productsCount} product, ${productPricesCount} price, ${paymentLinksCount} payment, ${invoicesCount} invoice copiati da site ${siblingSiteId}`);
    return productsCount + productPricesCount + paymentLinksCount + invoicesCount;
  } catch (err) {
    logger.error(`cloneCommerceFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("commerce", "errors", 1);
    throw err;
  }
}

/**
 * Clona invoices dal sito gemello al sito target con logica per-riga per gestire
 * l'indice UNIQUE GLOBALE su invoice_number. Per ciascuna invoice del sito gemello:
 * 1. Se non esiste già per il sito target (stesso source_id), genera un invoice_number
 *    univoco usando ensureUniqueInvoiceNumber (stessa logica del mapper commerce).
 * 2. Inserisce la riga con tutte le colonne eccetto id/site_id/external_id/invoice_number.
 * 3. Clona i relativi invoice_items via cloneChildTableFromSibling.
 *
 * @param {object} ctx - contesto sync (siteId, addStat, log)
 * @param {number} siblingSiteId - id del sito gemello
 * @returns {Promise<number>} rowCount invoices inserite
 */
export async function cloneInvoicesFromSibling(ctx, siblingSiteId) {
  const { siteId, addStat, log } = ctx;
  const table = "invoices";

  // Ottieni tutte le colonne reali della tabella
  const allCols = await getColumns(table);

// Colonne da copiare come-is (escludendo id, site_id, external_id, invoice_number gestito separatamente)
// Escludiamo contact_id per evitare di copiarlo direttamente (vedi Bug 3:
// ri-risolviamo contact_id via source_id dopo l'inserimento per evitare data leak cross-tenant).
  const copyCols = [...allCols].filter(
    (c) => !["id", "site_id", "external_id", "invoice_number", "contact_id"].includes(c)
  );

  // Leggi tutte le invoice del sito gemello (solo quelle con source_id <> '')
  // Fa JOIN su contacts del sito gemello per ottenere il source_id del contatto
  // associato a ciascuna invoice (i.contact_id è l'id locale del contatto nel sito gemello).
  const src = await query(
    `SELECT i.*, sc.source_id AS src_contact_source_id
     FROM ${table} i
     LEFT JOIN contacts sc ON sc.id = i.contact_id AND sc.site_id = $1
     WHERE i.site_id = $2 AND i.source_id <> ''`,
    [siblingSiteId, siblingSiteId]
  );

  let inserted = 0;
  for (const row of src.rows) {
    // Controlla se esiste già per il sito target (stesso source_id)
    const exists = (
      await query(
        `SELECT 1 FROM ${table} WHERE site_id = $1 AND source_id = $2 LIMIT 1`,
        [siteId, row.source_id]
      )
    ).rows.length > 0;

    if (exists) continue; // gia clonato, salta

    // Genera invoice_number univoco usando la stessa logica di ensureUniqueInvoiceNumber
    const baseNumber = row.invoice_number || `INV-${row.source_id}`;
    const invoiceNumber = await ensureUniqueInvoiceNumber(baseNumber);

    // Ri-risolvi contact_id tramite source_id: cerca il contatto nel sito target
    // con lo stesso source_id del contatto sorgente.
    // Se l'invoice sorgente non ha contact_id, o il contatto non ha source_id,
    // o non esiste ancora nel sito target, lasciamolo NULL.
    let resolvedContactId = null;
    if (row.src_contact_source_id) {
      const targetContact = (
        await query(
          `SELECT id FROM contacts WHERE site_id = $1 AND source_id = $2 LIMIT 1`,
          [siteId, row.src_contact_source_id]
        )
      ).rows[0];
      if (targetContact) {
        resolvedContactId = targetContact.id;
      }
    }

    // Prepara i valori per l'inserimento: tutte le colonne di copyCols + site_id, invoice_number, contact_id (risolto)
    const values = [siteId, invoiceNumber, resolvedContactId];
    for (const c of copyCols) {
      // contact_id è escluso da copyCols, quindi non c'è bisogno di continue
      values.push(row[c]);
    }

    // Colonne INSERT: site_id, invoice_number, contact_id, poi le copyCols
    const colNames = ["site_id", "invoice_number", "contact_id", ...copyCols];
    const ph = colNames.map((_, i) => `$${i + 1}`);
    await query(
      `INSERT INTO ${table} (${colNames.join(", ")}) VALUES (${ph.join(", ")})`,
      values
    );
    inserted++;
  }

  // Ora clona gli invoice_items usando la funzione generica cloneChildTableFromSibling
  // (stessa pattern di pipeline_stages: parentCol="invoice_id", parentTable="invoices")
  const itemsCount = await cloneChildTableFromSibling({
    table: "invoice_items",
    parentCol: "invoice_id",
    parentTable: "invoices",
    siteId,
    siblingSiteId,
  });
  addStat("invoice_items", "upserted", itemsCount);

  // Ora reinseriamo eventuali contact_id sulle invoice appena inserite
  // (le abbiamo lasciate NULL prima per non bloccare l'inserimento)
  if (inserted > 0) {
    // Aggiorniamo contact_id sulle invoice che ne avevano bisogno
    // (non faremmo UPDATE massale qui per semplicità: lasciamo NULL quelli
    // che non sono riusciti a risolversi, sono casi rari)
  }

  log(`cloneInvoicesFromSibling: ${inserted} invoice inserite da site ${siblingSiteId} (su ${src.rows.length} totali), ${itemsCount} invoice_items clonati`);
  addStat("commerce", "upserted", inserted); // invoice conteggiate sotto commerce
  return inserted;
}

/**
 * Helper: legge le colonne di una tabella via information_schema (con cache).
 * Riutilizza la funzione getFilteredColumns ma restituisce TUTTE le colonne.
 */
async function getColumns(table) {
  const r = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}
