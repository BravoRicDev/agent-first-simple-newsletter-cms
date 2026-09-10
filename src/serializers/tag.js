// Serializer tag: trasforma row DB in contratto API camelCase + uuid esterno.

import { publicId } from "../services/external-ids.js";

export function serializeTag(row, locationId) {
  if (!row) return null;
  return {
    id: publicId(row),
    locationId,
    name: row.name,
    color: row.color ?? null,
    dateAdded: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export function serializeTagList(rows, locationId) {
  return rows.map(row => serializeTag(row, locationId));
}
