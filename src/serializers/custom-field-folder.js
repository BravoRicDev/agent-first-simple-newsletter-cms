// Serializer custom field folder: trasforma row DB in contratto API camelCase + uuid esterno.

export function serializeFolder(row, locationId) {
  if (!row) return null;
  return {
    id: row.external_id,
    locationId,
    name: row.name,
    dateAdded: row.created_at ? new Date(row.created_at).toISOString() : null,
    dateUpdated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function serializeFolderList(rows, locationId) {
  return rows.map(row => serializeFolder(row, locationId));
}
