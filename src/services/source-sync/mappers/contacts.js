import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";
import { setCustomValues } from "../../custom-values.js";

async function ensureCustomFieldDef(siteId, fieldKey, objectKey = "contact") {
  const existing = (
    await query(
      "SELECT id FROM custom_fields WHERE site_id = $1 AND field_key = $2 AND object_key = $3 LIMIT 1",
      [siteId, fieldKey, objectKey]
    )
  ).rows[0];
  if (!existing) {
    await query(
      `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, active)
       VALUES ($1, $2, $3, $4, 'text', true)`,
      [siteId, objectKey, fieldKey, fieldKey]
    );
  }
}

async function upsertContact(ctx, extId, contact) {
  const { siteId, client, dryRun, log } = ctx;
  const email = contact.email || `${contact.id}@nomail.local`;

  try {
    // Adozione S1: cerca contatto email same-site (case-insensitive)
    const existing = (
      await query(
        "SELECT id, ghl_id FROM contacts WHERE site_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
        [siteId, email]
      )
    ).rows[0];

    // S1: si "adotta" un record locale esistente (stessa email) quando il suo
    // ghl_id NON è quello sorgente che stiamo per scrivere (doppio id: vedi
    // db/120_ghl_id_columns.sql — external_id resta SEMPRE l'id locale
    // dell'oggetto CMS, mai scritto/letto dal source-sync; ghl_id è l'id
    // esatto della risorsa su GoHighLevel, stringa non-uuid). Un record
    // creato dal CMS ha ghl_id = '' (default): l'adozione prevale quando
    // l'id GHL locale non coincide col sorgente, sovrascrivendolo con
    // quello reale. Se ghl_id === extId il record è già nostro: si
    // prosegue verso l'upsert normale (skip-if-unchanged/update).
    const shouldAdopt = existing && existing.ghl_id !== extId;
    const cols = {
      email,
      status: contact.status || "",
      notes: "",
      tags: Array.isArray(contact.tags) ? contact.tags : [],
    };
    const timestamps = {
      createdAt: contact.dateAdded,
      updatedAt: contact.dateUpdated,
    };

    if (dryRun) {
      if (shouldAdopt) return { row: existing, action: "adopted" };
      return { row: null, action: "inserted" };
    }

    if (shouldAdopt) {
      const upd = (
        await query(
          `UPDATE contacts SET ghl_id = $1, email = $2, status = $3, notes = $4, tags = $5::text[], updated_at = $6 WHERE id = $7 RETURNING *`,
          [extId, email, cols.status, cols.notes, contact.tags || [], timestamps.updatedAt || new Date(), existing.id]
        )
      ).rows[0];
      return { row: upd, action: "adopted" };
    }

    const { row, action } = await upsertByExternalId({
      table: "contacts",
      siteId,
      externalId: extId,
      cols,
      timestamps,
    });
    return { row, action };
  } catch (err) {
    log(`upsertContact ${extId}: ${err.message}`);
    throw err;
  }
}

async function storeProfiles(ctx, contactId, contact) {
  const { siteId, dryRun, log } = ctx;
  const PROFILE_KEYS_SET = new Set([
    "name",
    "firstName",
    "lastName",
    "phone",
    "companyName",
    "website",
  ]);
  const profileValues = {};
  for (const key of PROFILE_KEYS_SET) {
    if (contact[key] !== undefined && contact[key] !== null) {
      profileValues[key] = contact[key];
    }
  }
  // Verificato su una risposta REALE di GET /contacts/ (2026-08-26): il
  // contatto non ha mai un campo "name" — solo "contactName". Fallback,
  // non sostituzione: se in futuro l'API tornasse a esporre "name" resta
  // prioritario.
  if (profileValues.name === undefined && contact.contactName) {
    profileValues.name = contact.contactName;
  }

  const customFieldValues = {};
  if (contact.customFields && Array.isArray(contact.customFields)) {
    for (const cf of contact.customFields) {
      // Verificato dal vivo: i customFields sul contatto sono { id, value }
      // — MAI { key, field_value } come letto prima (fieldKey era sempre
      // undefined, quindi i custom field non venivano MAI sincronizzati).
      // "id" è l'id CRM sorgente della DEFINIZIONE campo: va risolto sul field_key
      // locale già salvato da mappers/custom-fields.js (ghl_id, non external_id).
      let fieldKey = cf.key || cf.field_key;
      if (!fieldKey && cf.id) {
        const def = (await query(
          "SELECT field_key FROM custom_fields WHERE ghl_id = $1 AND site_id = $2 LIMIT 1",
          [cf.id, siteId]
        )).rows[0];
        fieldKey = def?.field_key || null;
      }
      if (!fieldKey) continue;
      try {
        if (!dryRun) await ensureCustomFieldDef(siteId, fieldKey, "contact");
        customFieldValues[fieldKey] = cf.field_value ?? cf.value ?? null;
      } catch (err) {
        log(`customField ${fieldKey}: ${err.message}`);
      }
    }
  }

  const allValues = { ...profileValues, ...customFieldValues };
  if (Object.keys(allValues).length > 0 && !dryRun) {
    await setCustomValues(siteId, contactId, "contact", allValues);
  }
}

// Soglia di conferma per lo stop anticipato: più di una pagina piena di
// record consecutivi già sincronizzati (non solo 1, per margine di
// sicurezza contro casi limite di ordinamento/tie-break).
const EARLY_STOP_THRESHOLD = 25;

export async function syncAll(ctx, onPage) {
  const { siteId, client, cfg, dryRun, addStat, knownContacts, log } = ctx;

  // Sync incrementale (richiesta cliente 2026-09-09: "ordinate per data di
  // update, i più recenti prima; non appena raggiunge un record già
  // sincronizzato sa che da lì in poi è tutto ok e si ferma").
  //
  // Verificato dal vivo contro il CRM sorgente reale (site 21, 2026-09-09):
  // POST /contacts/search supporta sort=[{field:"dateUpdated",direction:
  // "desc"}] con cursore searchAfter — GET /contacts/ (usato in precedenza)
  // NON supporta alcun ordinamento, solo paginazione per id di inserimento.
  // Vedi client.js:paginateSearchSorted per i dettagli della verifica.
  //
  // Con l'ordinamento decrescente, appena si incontra una SERIE di record
  // già sincronizzati (stesso dateUpdated locale, azione "unchanged"), tutto
  // ciò che segue è per costruzione meno recente ⇒ già sincronizzato anche
  // quello ⇒ si può fermare la paginazione senza continuare a scaricare
  // l'intero storico ad ogni run.
  //
  // GUARDIA DI SICUREZZA: lo stop anticipato si attiva SOLO se l'ULTIMO run
  // per questo sito ha completato l'intera sync (source_sync_state.
  // last_status='ok' per la risorsa "contacts" — scritto da index.js solo
  // quando l'intero sweep finisce senza eccezioni, vedi runSync). Se il
  // sito non ha mai completato un giro, o l'ultimo è stato interrotto
  // (budget esaurito/errore), NON ci si può fidare che "già visto" implichi
  // "tutto il resto è già sincronizzato" — quel giro potrebbe non essere
  // mai arrivato fino a un certo contatto. In quel caso si fa un giro
  // completo (comportamento previo, sempre corretto anche se più costoso),
  // e lo stop anticipato torna disponibile dal prossimo run se questo
  // completa con successo.
  let earlyStopEnabled = false;
  if (!dryRun) {
    const prev = (
      await query(
        "SELECT last_status FROM source_sync_state WHERE site_id = $1 AND resource_type = 'contacts'",
        [siteId]
      )
    ).rows[0];
    earlyStopEnabled = prev?.last_status === "ok";
  }
  let consecutiveUnchanged = 0;

  try {
    await client.paginateSearchSorted(
      "/contacts/search",
      { locationId: cfg.location_id, pageLimit: 100, sortField: "dateUpdated", sortDirection: "desc" },
      async (pageContacts) => {
        addStat("contacts", "fetched", pageContacts.length);
        const pageExtIds = [];

        for (const c of pageContacts) {
          try {
            const { row, action } = await upsertContact(ctx, c.id, c);
            if (action === "inserted") { addStat("contacts", "upserted", 1); consecutiveUnchanged = 0; }
            else if (action === "updated") { addStat("contacts", "updated", 1); consecutiveUnchanged = 0; }
            else if (action === "adopted") { addStat("contacts", "updated", 1); consecutiveUnchanged = 0; }
            else { addStat("contacts", "skipped", 1); consecutiveUnchanged++; }

            if (row && row.id) {
              pageExtIds.push(c.id);
              knownContacts.add(c.id);
              await storeProfiles(ctx, row.id, c);
            }
          } catch (err) {
            addStat("contacts", "errors", 1);
            log(`contact ${c.id}: ${err.message}`);
            consecutiveUnchanged = 0; // un errore non conta come "già sincronizzato" confermato
          }
        }

        if (onPage && pageExtIds.length > 0) {
          await onPage(pageExtIds);
        }

        if (earlyStopEnabled && consecutiveUnchanged >= EARLY_STOP_THRESHOLD) {
          log(`sync incrementale: ${consecutiveUnchanged} contatti consecutivi già sincronizzati (ordine dateUpdated desc) — stop anticipato`);
          return false; // segnala a paginateSearchSorted di fermare la paginazione
        }
        return undefined;
      }
    );
  } catch (err) {
    addStat("contacts", "errors", 1);
    log(`syncAll contacts fallito: ${err.message}`);
    throw err;
  }
}

export async function syncForContacts(ctx, extIds) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  for (const extId of extIds) {
    // Note
    try {
      // sendLocationId:false — GET /contacts/{id}/notes rifiuta locationId
      // in query con 422 "property locationId should not exist" (il
      // contatto è già scoped dall'id nel path): verificato dal vivo su
      // centinaia di contatti reali, causava fallimento sistematico e
      // silenzioso di TUTTA la sync di note/task (vedi catch sotto).
      const notesRes = await client.get(`/contacts/${extId}/notes`, {}, { sendLocationId: false });
      const notes = notesRes?.notes || notesRes || [];
      // Il contatto proprietario delle note è quello del loop (extId), NON un
      // campo "contactEmail" sul payload nota — non esiste su GHL reale, quindi
      // era sempre vuoto: le note sincronizzate risultavano orfane (contact_id
      // mai impostato, contact_email vuoto, invisibili dalla scheda contatto).
      const noteContactRow = (await query(
        "SELECT id, email FROM contacts WHERE ghl_id=$1 AND site_id=$2",
        [extId, siteId]
      )).rows[0];
      for (const n of notes) {
        try {
          const userId = n.userId
            ? await findInternalId("users", siteId, n.userId)
            : null;
          const cols = {
            contact_email: noteContactRow?.email || "",
            contact_id: noteContactRow?.id || null,
            author_type: n.authorType || "human",
            author_name: n.authorName || "",
            body: n.body || "",
          };
          const timestamps = {
            createdAt: n.dateAdded || new Date(),
            updatedAt: new Date(),
          };

          if (!dryRun) {
            const { action } = await upsertByExternalId({
              table: "contact_notes",
              siteId,
              externalId: n.id,
              cols,
              timestamps,
            });
            // S4: non contare come "upserted" un record invariato (idempotenza).
            if (action !== "unchanged") addStat("contacts", "upserted", 1);
          } else {
            addStat("contacts", "upserted", 1);
          }
        } catch (err) {
          addStat("contacts", "errors", 1);
          log(`note ${n.id}: ${err.message}`);
        }
      }
    } catch (err) {
      // Prima non incrementava nessuno stat: un fallimento sistematico
      // (es. il 422 locationId sopra) restava invisibile nelle stats del
      // run, fetched===0 senza errors a segnalarlo.
      addStat("contacts", "errors", 1);
      log(`syncForContacts notes ${extId}: ${err.message}`);
    }

    // Tasks
    try {
      // sendLocationId:false — stesso motivo di /notes sopra.
      const tasksRes = await client.get(`/contacts/${extId}/tasks`, {}, { sendLocationId: false });
      const tasks = tasksRes?.tasks || tasksRes || [];
      for (const t of tasks) {
        try {
          const assigneeId = t.assigneeId
            ? await findInternalId("users", siteId, t.assigneeId)
            : null;
          const cols = {
            email: t.contactEmail || "",
            title: t.title || "",
            notes: t.notes || t.body || "",
            due_at: t.dueDate || null,
            status: t.completed ? "done" : "open",
          };
          const timestamps = {
            createdAt: t.dateAdded || new Date(),
            // Usa dateUpdated del sorgente (non "adesso"): altrimenti ogni
            // sync ribatte il record come modificato, rompendo l'idempotenza S4.
            updatedAt: t.dateUpdated || t.dateAdded || new Date(),
          };

          if (!dryRun) {
            const { action } = await upsertByExternalId({
              table: "tasks",
              siteId,
              externalId: t.id,
              cols: { ...cols, assignee_id: assigneeId },
              timestamps,
            });
            if (action !== "unchanged") addStat("contacts", "upserted", 1);
          } else {
            addStat("contacts", "upserted", 1);
          }
        } catch (err) {
          addStat("contacts", "errors", 1);
          log(`task ${t.id}: ${err.message}`);
        }
      }
    } catch (err) {
      addStat("contacts", "errors", 1);
      log(`syncForContacts tasks ${extId}: ${err.message}`);
    }
  }
}

export async function fetchSingle(ctx, extId) {
  const { siteId, client, knownContacts, log } = ctx;

  try {
    const contactRes = await client.get(`/contacts/${extId}`);
    const contact = contactRes?.contact || contactRes;
    if (!contact) return null;

    const { row, action } = await upsertContact(ctx, contact.id, contact);
    if (row && row.id) {
      knownContacts.add(contact.id);
      await storeProfiles(ctx, row.id, contact);
    }
    return row;
  } catch (err) {
    log(`fetchSingle ${extId}: ${err.message}`);
    return null;
  }
}
