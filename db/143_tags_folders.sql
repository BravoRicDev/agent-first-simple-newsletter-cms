-- Onda A — Tags + Custom field folders
-- Tabelle per tags per-sito e cartelle custom-field per-sito.
-- Tutte idempotenti: riexecuzione OK.

CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_external_id_partial ON tags(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tags_site_id ON tags(site_id);

CREATE TABLE IF NOT EXISTS custom_field_folders (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_field_folders_external_id_partial ON custom_field_folders(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_field_folders_site_id ON custom_field_folders(site_id);
