-- 086: tabella "tags" per il mapper source-sync (tag del CRM sorgente).
-- Copiata da db/094_tags_folders.sql del repo sorgente: si copia SOLO la
-- parte relativa a "tags"; "custom_field_folders" non serve al source-sync.
-- Idempotente: CREATE TABLE IF NOT EXISTS + indici IF NOT EXISTS.

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
