-- 102 — Clone API, Onda H2: Media Files Registry + Custom Objects Schema.
-- Recuperata da file di lavoro mai committati (vedi nota in
-- 097_clone_sites_columns.sql). Idempotente: doppio run OK.

-- media_files: registro dei file (non tocca il filesystem — solo
-- riferimenti a file GIÀ in storage registrati dalle route admin). Parità
-- clone API per gli endpoint /files.
CREATE TABLE IF NOT EXISTS media_files (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  filename VARCHAR(500) NOT NULL,
  url VARCHAR(1000) NOT NULL,
  mime_type VARCHAR(100),
  size_bytes BIGINT DEFAULT 0,
  alt TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, filename, url)
);

CREATE UNIQUE INDEX IF NOT EXISTS media_files_external_id_idx
  ON media_files(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_files_site_id_idx ON media_files(site_id);

-- object_definitions: schema degli oggetti custom per tenant (proprietà,
-- veicoli, ecc). object_key è slug univoco per site.
CREATE TABLE IF NOT EXISTS object_definitions (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  object_key VARCHAR(100) NOT NULL,
  plural_label VARCHAR(255),
  primary_field VARCHAR(100) NOT NULL DEFAULT 'name',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, object_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS object_definitions_external_id_idx
  ON object_definitions(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_definitions_site_id_idx ON object_definitions(site_id);

-- object_records: istanze di oggetti custom (un record per proprietà,
-- veicolo, ecc).
CREATE TABLE IF NOT EXISTS object_records (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  definition_id INTEGER NOT NULL REFERENCES object_definitions(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS object_records_external_id_idx
  ON object_records(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_records_site_id_idx ON object_records(site_id);
CREATE INDEX IF NOT EXISTS object_records_definition_id_idx ON object_records(definition_id);

-- object_associations: relazioni tra record (m:n generico). from_record_id
-- punta al record che "possiede" la relazione; to_record_id al target.
-- relation è una stringa descrittiva (es. "parte_di", "related", "owner").
CREATE TABLE IF NOT EXISTS object_associations (
  id SERIAL PRIMARY KEY,
  from_record_id INTEGER NOT NULL REFERENCES object_records(id) ON DELETE CASCADE,
  to_record_id INTEGER NOT NULL REFERENCES object_records(id) ON DELETE CASCADE,
  relation VARCHAR(100) NOT NULL DEFAULT 'related',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_record_id, to_record_id, relation)
);

CREATE INDEX IF NOT EXISTS object_associations_from_idx ON object_associations(from_record_id);
CREATE INDEX IF NOT EXISTS object_associations_to_idx ON object_associations(to_record_id);
