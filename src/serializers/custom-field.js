// Serializer custom field: trasforma row DB in contratto API camelCase + uuid esterno + dataType enum.

import { publicId } from "../services/external-ids.js";

const TYPE_MAP = {
  text: "TEXT",
  textarea: "LARGE_TEXT",
  number: "NUMERIC",
  date: "DATE",
  checkbox: "CHECKBOX",
  select: "DROPDOWN",
  radio: "RADIO",
};

function serializeOptions(options) {
  if (!options) return [];
  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(options)) return [];

  return options.map(opt => {
    if (typeof opt === "string") {
      return { id: opt, name: opt };
    }
    return opt;
  });
}

export function serializeCustomField(row, locationId) {
  if (!row) return null;
  return {
    id: publicId(row),
    locationId,
    name: row.name,
    fieldKey: row.field_key,
    dataType: TYPE_MAP[row.type] || "TEXT",
    options: serializeOptions(row.options),
    dateAdded: row.created_at ? new Date(row.created_at).toISOString() : null,
    dateUpdated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function serializeCustomFieldList(rows, locationId) {
  return rows.map(row => serializeCustomField(row, locationId));
}

// ─────────────────────────────────────────────────────────────────────────
// Shape GHL-true per GET /locations/{locationId}/customFields — DIVERSA
// da serializeCustomField sopra (usata da /custom-fields, alias legacy
// mantenuto per il consumatore esistente crm-v2, mai toccato qui).
// Verificato dal vivo su GHL reale (src/services/source-sync/mappers/
// custom-fields.js:57-90, doc/DIVERGENZA-CUSTOM-FIELDS.md):
//   - fieldKey prefissato col model, es. "contact.citta"
//   - il campo opzioni si chiama picklistOptions, non options
//   - dateAdded presente, dateUpdated MAI osservato → non lo includiamo
//   - dataType nel vocabolario reale (TEXT, LARGE_TEXT, NUMERICAL, ecc.),
//     non nel dialetto interno storico (TEXT, NUMERIC, DROPDOWN, ecc.)
// Il nostro schema interno non distingue tutti i sottotipi reali (PHONE/
// MONETORY/EMAIL restano TEXT, MULTIPLE_OPTIONS/TEXTBOX_LIST/FILE_UPLOAD
// non rappresentabili): mappatura best-effort sul tipo più vicino già
// esistente nella colonna `type`.
const GHL_TYPE_MAP = {
  text: "TEXT",
  textarea: "LARGE_TEXT",
  number: "NUMERICAL",
  date: "DATE",
  checkbox: "CHECKBOX",
  select: "SINGLE_OPTIONS",
  radio: "RADIO",
};

export function serializeCustomFieldGhl(row, locationId) {
  if (!row) return null;
  const model = row.object_key === "opportunity" ? "opportunity" : "contact";
  return {
    id: publicId(row),
    locationId,
    name: row.name,
    fieldKey: `${model}.${row.field_key}`,
    dataType: GHL_TYPE_MAP[row.type] || "TEXT",
    model,
    picklistOptions: serializeOptions(row.options),
    dateAdded: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export function serializeCustomFieldGhlList(rows, locationId) {
  return rows.map(row => serializeCustomFieldGhl(row, locationId));
}

// Round 18: Custom VALUES sorgente (tabella source_custom_values, mirror del
// sorgente GET /locations/{id}/customValues). Verificato su schema reale:
// nessun external_id proprio → id pubblico = source_id REALE di sorgente, niente
// doppio id. sorgente serve i valori dentro la stessa risposta di
// GET /customFields/ (chiave `customValues`), non ha un endpoint
// /customValues/:id separato.
export function serializeCustomValue(row) {
  return {
    id: row.source_id,
    name: row.name || "",
    value: row.value || "",
  };
}