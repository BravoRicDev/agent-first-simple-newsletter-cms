import { upsertByExternalId } from "../upsert.js";

function slugify(label) {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function mapFieldType(sourceType) {
  // Mappa dataType sorgente sui SOLI tipi ammessi dal nostro schema
  // (custom-fields service: text|number|date|checkbox|select|textarea|radio).
  // ATTENZIONE: il vocabolario REALE di GHL (verificato dal vivo, vedi
  // serializers/custom-field.js) usa NUMERICAL/SINGLE_OPTIONS/RADIO, non i
  // nomi "NUMBER"/"DROPDOWN"/"MULTISELECT" sotto — quelli erano un dialetto
  // storico mai riscontrato realmente, tenuto solo come rete di sicurezza.
  // Bug corretto in questo round: NUMERICAL, SINGLE_OPTIONS e RADIO
  // mancavano del tutto e cadevano tutti sul default "text" (rilevato dal
  // motore di shadow-comparison, vedi services/ghl-parity.js).
  if (!sourceType) return "text";
  switch (String(sourceType).toUpperCase()) {
    case "NUMERICAL":
    case "NUMERIC":
    case "DECIMAL":
    case "INTEGER":
    case "NUMBER":
      return "number";
    case "DATE":
    case "DATETIME":
    case "TIMESTAMP":
      return "date";
    case "BOOLEAN":
    case "BOOL":
    case "CHECKBOX":
      return "checkbox";
    case "SINGLE_OPTIONS":
    case "SELECT":
    case "DROPDOWN":
    case "MULTISELECT":
      return "select";
    case "RADIO":
      return "radio";
    case "TEXTAREA":
    case "LARGE_TEXT":
      return "textarea";
    // Intenzionalmente NON mappati (restano "text", best-effort — vedi
    // serializers/custom-field.js): PHONE, MONETORY, EMAIL (nessun tipo
    // locale equivalente), MULTIPLE_OPTIONS/TEXTBOX_LIST/FILE_UPLOAD (non
    // rappresentabili con una singola select locale senza perdita di
    // semantica multi-valore).
    default:
      return "text";
  }
}

// Toglie il prefisso "<model>." da fieldKey (es. "contact.citta" -> "citta").
// Verificato dal vivo (GET /locations/{locationId}/customFields,
// 2026-08-26): fieldKey è sempre prefissato col model del campo.
function localFieldKey(f) {
  const fk = f.fieldKey || "";
  const prefix = `${f.model}.`;
  return fk.startsWith(prefix) ? fk.slice(prefix.length) : (fk || slugify(f.name || "field"));
}

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  // Doc CRM sorgente 2021-07-28: GET /custom-fields/object-key/{contact|opportunity}
  // risponde 400 "Api does not support objectKey of type contact or
  // opportunity" sull'API reale — verificato dal vivo, non un caso isolato
  // (provati anche 'contacts'/'opportunities'/'all', tutti rifiutati).
  // L'endpoint reale che funziona è GET /locations/{locationId}/customFields:
  // UNA chiamata sola restituisce contact+opportunity insieme, ciascuno
  // marcato con "model". Nessuna paginazione osservata (106 campi in
  // un'unica risposta su un account reale).
  try {
    // sendLocationId:false — locationId è già nel path; duplicarlo in query
    // dà 422 "property locationId should not exist" su questo endpoint
    // (verificato dal vivo — incoerente con altri /locations/{id}/... che
    // lo tollerano: meglio non affidarsi a una tolleranza non documentata).
    const res = await client.get(`/locations/${cfg.location_id}/customFields`, {}, { sendLocationId: false });
    const fields = res?.customFields || res || [];
    addStat("custom-fields", "fetched", fields.length);

    for (const f of fields) {
      const objKey = f.model === "opportunity" ? "opportunity" : "contact";
      try {
        const fieldKey = localFieldKey(f);
        const cols = {
          object_key: objKey,
          field_key: fieldKey,
          name: f.name || "",
          type: mapFieldType(f.dataType),
          active: true,
          // picklistOptions verificato dal vivo sui campi CHECKBOX/SELECT;
          // f.options non esiste sulla risposta reale.
          options: JSON.stringify(f.picklistOptions || []),
        };
        const timestamps = {
          createdAt: f.dateAdded,
          // dateUpdated non osservato sulla risposta reale per questa
          // risorsa (a differenza di contacts) — upsertByExternalId usa
          // createdAt come fallback quando updatedAt manca.
        };

        if (dryRun) {
          addStat("custom-fields", "upserted", 1);
          continue;
        }

        const { action } = await upsertByExternalId({
          table: "custom_fields",
          siteId,
          externalId: f.id,
          cols,
          timestamps,
        });

        if (action === "inserted") addStat("custom-fields", "upserted", 1);
        else if (action === "updated") addStat("custom-fields", "updated", 1);
        else addStat("custom-fields", "skipped", 1);
      } catch (err) {
        addStat("custom-fields", "errors", 1);
        log(`custom-field ${objKey}/${f.id}: ${err.message}`);
      }
    }
  } catch (err) {
    addStat("custom-fields", "errors", 1);
    log(`syncAll custom-fields fallito: ${err.message}`);
  }
}
