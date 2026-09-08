// Serializer tag: trasforma row DB in contratto API camelCase + uuid esterno.

export function serializeTag(row, locationId) {
  if (!row) return null;
  return {
    id: row.external_id,
    locationId,
    name: row.name,
    color: row.color ?? null,
    dateAdded: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export function serializeTagList(rows, locationId) {
  return rows.map(row => serializeTag(row, locationId));
}
