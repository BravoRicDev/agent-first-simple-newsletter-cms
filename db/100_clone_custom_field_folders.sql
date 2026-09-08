-- 100 — Clone API, Onda A: cartelle custom-field per-sito.
-- Recuperata da file di lavoro mai committati (vedi nota in
-- 097_clone_sites_columns.sql). NB: il file originale (mai committato)
-- creava anche una tabella `tags` propria, OMESSA qui perché `tags` è già
-- ufficiale (db/086_tags.sql + ghl_id da db/120_ghl_id_columns.sql) —
-- ricrearla avrebbe rischiato di divergere dallo schema già in uso dal
-- source-sync.
CREATE TABLE IF NOT EXISTS custom_field_folders (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_field_folders_external_id_partial
  ON custom_field_folders(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_field_folders_site_id ON custom_field_folders(site_id);
