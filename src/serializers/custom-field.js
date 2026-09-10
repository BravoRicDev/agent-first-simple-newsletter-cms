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

// Round 18: Custom VALUES GHL (tabella ghl_custom_values, mirror del
// sorgente GET /locations/{id}/customValues). Verificato su schema reale:
// nessun external_id proprio → id pubblico = ghl_id REALE di GHL, niente
// doppio id. GHL serve i valori dentro la stessa risposta di
// GET /customFields/ (chiave `customValues`), non ha un endpoint
// /customValues/:id separato.
export function serializeCustomValue(row) {
  return {
    id: row.ghl_id,
    name: row.name || "",
    value: row.value || "",
  };
}