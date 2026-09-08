import { query } from "../../db.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Clonazione locale da un sito "gemello" (stesso account/location GHL,
// db/126_ghl_id_per_site.sql) — evita di rifare l'intero giro di chiamate
// GHL per contatti + sotto-risorse (note/task/opportunità/conversazioni/
// appuntamenti: O(numero contatti) chiamate, la parte di gran lunga più
// costosa del budget API) quando un altro sito CMS ha GIÀ sincronizzato
// gli STESSI dati dallo STESSO CRM sorgente. Richiesta cliente: "i contatti
// di site_21 e site_22 sono gli stessi... non serve [risincronizzarli],
// altrimenti rischiamo di saturare le api di ghl per niente".
//
// Copia via SQL locale (zero chiamate GHL, zero consumo di budget/quota):
// stesso esito finale di un sync via API (ogni sito ha la propria copia
// locale indipendente, filtrata per site_id come sempre), ma senza
// rifare il fetch. I riferimenti a risorse interne (pipeline_id,
// calendar_id) vengono ri-risolti sulle copie GIÀ presenti nel sito
// target (pipelines/calendars/users sincronizzano comunque in modo
// indipendente per ogni sito — sono economici, poche decine/centinaia di
// righe, non la parte costosa) tramite il loro ghl_id condiviso.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Trova un sito "gemello": stesso base_url+location_id (stesso account
 * GHL), source-sync abilitato, con almeno un contatto già sincronizzato.
 * Se più siti gemelli esistono, sceglie quello con più contatti (il più
 * "completo" da cui copiare).
 */
export async function findSiblingWithContacts(siteId, cfg) {
  const r = await query(
    `SELECT c.site_id, cnt.n
       FROM source_sync_config c
       JOIN LATERAL (
         SELECT COUNT(*) AS n FROM contacts WHERE site_id = c.site_id AND ghl_id <> ''
       ) cnt ON true
      WHERE c.enabled = true
        AND c.site_id != $1
        AND c.base_url = $2
        AND c.location_id = $3
        AND cnt.n > 0
      ORDER BY cnt.n DESC
      LIMIT 1`,
    [siteId, cfg.base_url, cfg.location_id]
  );
  return r.rows[0]?.site_id || null;
}

/**
 * Copia contatti + note/task/opportunità/conversazioni(+messaggi)/
 * appuntamenti dal sito gemello nel sito target. Idempotente (ON CONFLICT
 * sull'indice UNIQUE(site_id, ghl_id) di ciascuna tabella, introdotto da
 * db/126_ghl_id_per_site.sql): rieseguibile ad ogni tick come un sync
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
      `INSERT INTO contacts (site_id, ghl_id, email, tags, status, notes, created_at, updated_at)
       SELECT $1, ghl_id, email, tags, status, notes, created_at, updated_at
       FROM contacts WHERE site_id = $2 AND ghl_id <> ''
       ON CONFLICT (site_id, ghl_id) WHERE ghl_id <> '' DO UPDATE SET
         email = EXCLUDED.email, tags = EXCLUDED.tags, status = EXCLUDED.status,
         notes = EXCLUDED.notes, updated_at = EXCLUDED.updated_at
       RETURNING ghl_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", contactsRes.rowCount);
    // knownContacts va aggiornato: la ricorsione discovery (submission
    // orfane) e l'hunt subresource per pagina si basano su questo set.
    for (const row of contactsRes.rows) ctx.knownContacts.add(row.ghl_id);

    const notesRes = await query(
      `INSERT INTO contact_notes (site_id, ghl_id, contact_email, author_type, author_name, body, created_at, updated_at, contact_id)
       SELECT $1, n.ghl_id, n.contact_email, n.author_type, n.author_name, n.body, n.created_at, n.updated_at, tc.id
       FROM contact_notes n
       LEFT JOIN contacts tc ON tc.site_id = $1 AND tc.email = n.contact_email
       WHERE n.site_id = $2 AND n.ghl_id <> ''
       ON CONFLICT (site_id, ghl_id) WHERE ghl_id <> '' DO UPDATE SET
         body = EXCLUDED.body, updated_at = EXCLUDED.updated_at, contact_id = EXCLUDED.contact_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", notesRes.rowCount);

    const tasksRes = await query(
      `INSERT INTO tasks (site_id, ghl_id, email, title, notes, due_at, status, created_at, reminder_date)
       SELECT $1, ghl_id, email, title, notes, due_at, status, created_at, reminder_date
       FROM tasks WHERE site_id = $2 AND ghl_id <> ''
       ON CONFLICT (site_id, ghl_id) WHERE ghl_id <> '' DO UPDATE SET
         title = EXCLUDED.title, notes = EXCLUDED.notes, due_at = EXCLUDED.due_at,
         status = EXCLUDED.status, reminder_date = EXCLUDED.reminder_date`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", tasksRes.rowCount);

    // Opportunità: pipeline_id va ri-risolto sulla copia locale del sito
    // target (stesso ghl_id di pipeline, id interno diverso).
    const oppsRes = await query(
      `INSERT INTO opportunities (
         site_id, ghl_id, contact_email, contact_name, contact_company, pipeline_id, stage,
         title, amount, probability, status, expected_close_at, notes, source, last_status_change,
         lost_reason, created_at, updated_at
       )
       SELECT $1, o.ghl_id, o.contact_email, o.contact_name, o.contact_company, tp.id, o.stage,
              o.title, o.amount, o.probability, o.status, o.expected_close_at, o.notes, o.source,
              o.last_status_change, o.lost_reason, o.created_at, o.updated_at
       FROM opportunities o
       LEFT JOIN pipelines sp ON sp.id = o.pipeline_id
       LEFT JOIN pipelines tp ON tp.site_id = $1 AND tp.ghl_id = sp.ghl_id AND sp.ghl_id <> ''
       WHERE o.site_id = $2 AND o.ghl_id <> ''
       ON CONFLICT (site_id, ghl_id) WHERE ghl_id <> '' DO UPDATE SET
         stage = EXCLUDED.stage, title = EXCLUDED.title, amount = EXCLUDED.amount,
         probability = EXCLUDED.probability, status = EXCLUDED.status,
         expected_close_at = EXCLUDED.expected_close_at, notes = EXCLUDED.notes,
         last_status_change = EXCLUDED.last_status_change, lost_reason = EXCLUDED.lost_reason,
         updated_at = EXCLUDED.updated_at, pipeline_id = EXCLUDED.pipeline_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", oppsRes.rowCount);

    const convRes = await query(
      `INSERT INTO conversations (site_id, ghl_id, contact_email, channel, status, subject, created_at, updated_at, unread_count, starred)
       SELECT $1, ghl_id, contact_email, channel, status, subject, created_at, updated_at, unread_count, starred
       FROM conversations WHERE site_id = $2 AND ghl_id <> ''
       ON CONFLICT (site_id, ghl_id) WHERE ghl_id <> '' DO UPDATE SET
         status = EXCLUDED.status, subject = EXCLUDED.subject, updated_at = EXCLUDED.updated_at,
         unread_count = EXCLUDED.unread_count, starred = EXCLUDED.starred
       RETURNING id, ghl_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", convRes.rowCount);

    // Messaggi: legati a conversation_id (nessun ghl_id proprio in questa
    // tabella — non toccata da db/120/126). Copiamo per ogni conversazione
    // appena upsertata risolvendo il nuovo conversation_id locale.
    let msgCount = 0;
    for (const conv of convRes.rows) {
      const siblingConv = (
        await query(
          "SELECT id FROM conversations WHERE site_id = $1 AND ghl_id = $2",
          [siblingSiteId, conv.ghl_id]
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
         site_id, ghl_id, contact_name, contact_email, contact_phone, title, description,
         start_time, end_time, status, timezone, calendar_id, appointment_status,
         cancelled_at, created_at, updated_at
       )
       SELECT $1, a.ghl_id, a.contact_name, a.contact_email, a.contact_phone, a.title, a.description,
              a.start_time, a.end_time, a.status, a.timezone, tc.id, a.appointment_status,
              a.cancelled_at, a.created_at, a.updated_at
       FROM booking_appointments a
       LEFT JOIN calendars sc ON sc.id = a.calendar_id
       LEFT JOIN calendars tc ON tc.site_id = $1 AND tc.ghl_id = sc.ghl_id AND sc.ghl_id <> ''
       WHERE a.site_id = $2 AND a.ghl_id <> ''
       ON CONFLICT (site_id, ghl_id) WHERE ghl_id <> '' DO UPDATE SET
         title = EXCLUDED.title, description = EXCLUDED.description, start_time = EXCLUDED.start_time,
         end_time = EXCLUDED.end_time, status = EXCLUDED.status, appointment_status = EXCLUDED.appointment_status,
         cancelled_at = EXCLUDED.cancelled_at, updated_at = EXCLUDED.updated_at, calendar_id = EXCLUDED.calendar_id`,
      [siteId, siblingSiteId]
    );
    addStat("contacts", "upserted", apptRes.rowCount);

    log(`cloneContactsFromSibling: ${contactsRes.rowCount} contatti, ${notesRes.rowCount} note, ${tasksRes.rowCount} task, ${oppsRes.rowCount} opportunità, ${convRes.rowCount} conversazioni, ${msgCount} messaggi, ${apptRes.rowCount} appuntamenti copiati da site ${siblingSiteId} (zero chiamate GHL)`);
  } catch (err) {
    logger.error(`cloneContactsFromSibling (site ${siteId} da ${siblingSiteId}): ${err.message}`);
    addStat("contacts", "errors", 1);
    throw err;
  }
}
