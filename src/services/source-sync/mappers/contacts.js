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
        "SELECT id, external_id FROM contacts WHERE site_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
        [siteId, email]
      )
    ).rows[0];

    // S1: si "adotta" SOLO un record locale puro (senza external_id).
    // Se external_id === extId il record è già nostro: prosegui verso
    // l'upsert normale che gestisce skip-if-unchanged/update correttamente.
    const shouldAdopt = existing && !existing.external_id;
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
          `UPDATE contacts SET external_id = $1, email = $2, status = $3, notes = $4, tags = $5::text[], updated_at = $6 WHERE id = $7 RETURNING *`,
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
      // locale già salvato da mappers/custom-fields.js (external_id).
      let fieldKey = cf.key || cf.field_key;
      if (!fieldKey && cf.id) {
        const def = (await query(
          "SELECT field_key FROM custom_fields WHERE external_id = $1 AND site_id = $2 LIMIT 1",
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

export async function syncAll(ctx, onPage) {
  const { siteId, client, cfg, dryRun, addStat, knownContacts, log } = ctx;

  try {
    await client.paginate(
      "/contacts/",
      { locationId: cfg.location_id },
      async (pageContacts) => {
        addStat("contacts", "fetched", pageContacts.length);
        const pageExtIds = [];

        for (const c of pageContacts) {
          try {
            const { row, action } = await upsertContact(ctx, c.id, c);
            if (action === "inserted") addStat("contacts", "upserted", 1);
            else if (action === "updated") addStat("contacts", "updated", 1);
            else if (action === "adopted") addStat("contacts", "updated", 1);
            else addStat("contacts", "skipped", 1);

            if (row && row.id) {
              pageExtIds.push(c.id);
              knownContacts.add(c.id);
              await storeProfiles(ctx, row.id, c);
            }
          } catch (err) {
            addStat("contacts", "errors", 1);
            log(`contact ${c.id}: ${err.message}`);
          }
        }

        if (onPage && pageExtIds.length > 0) {
          await onPage(pageExtIds);
        }
      },
      {
        // GET /contacts/ (doc CRM sorgente 2021-07-28) non restituisce alcun campo
        // "meta": il cursore per la pagina successiva va ricavato dall'ULTIMO
        // contatto della pagina corrente (startAfterId = suo id, startAfter =
        // il suo dateAdded in epoch ms). Prima di questa fix il client leggeva
        // un fantomatico meta.nextPage, causando un ciclo in produzione.
        cursorFrom: (lastContact) => ({
          startAfterId: lastContact?.id,
          startAfter: lastContact?.dateAdded ? new Date(lastContact.dateAdded).getTime() : undefined,
        }),
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
      const notesRes = await client.get(`/contacts/${extId}/notes`);
      const notes = notesRes?.notes || notesRes || [];
      for (const n of notes) {
        try {
          const userId = n.userId
            ? await findInternalId("users", siteId, n.userId)
            : null;
          const cols = {
            contact_email: n.contactEmail || "",
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
      log(`syncForContacts notes ${extId}: ${err.message}`);
    }

    // Tasks
    try {
      const tasksRes = await client.get(`/contacts/${extId}/tasks`);
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
