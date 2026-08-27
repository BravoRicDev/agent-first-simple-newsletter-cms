import { query } from "../db.js";

let cache = {};

export async function loadSettings() {
  const result = await query("SELECT key, value FROM settings WHERE site_id IS NULL");
  cache = {};
  for (const row of result.rows) {
    cache[row.key] = row.value;
  }
}

export function getSetting(key) {
  return cache[key];
}

export async function setSetting(key, value) {
  const updateResult = await query(
    "UPDATE settings SET value = $1 WHERE site_id IS NULL AND key = $2",
    [value, key]
  );
  if (updateResult.rowCount === 0) {
    await query(
      "INSERT INTO settings (site_id, key, value) VALUES (NULL, $1, $2)",
      [key, value]
    );
  }
  cache[key] = value;
}
