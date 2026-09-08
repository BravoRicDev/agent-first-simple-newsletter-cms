-- 099 — Clone API, Onda G: Agency, Teams, Team Members, User Locations.
-- Gerarchia location→agency, team per sito, utenti multi-sito.
-- Recuperata da file di lavoro mai committati (vedi nota in
-- 097_clone_sites_columns.sql). IDEMPOTENTE: IF NOT EXISTS / DO $$ ... END $$.

-- Agencies: livello superiore, raccoglie più location/site.
CREATE TABLE IF NOT EXISTS agencies (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agencies_external_id_key
  ON agencies(external_id) WHERE external_id IS NOT NULL;

-- Colonne agency/business su sites (agency_id richiede che la tabella
-- agencies esista già in questo stesso file, sopra).
DO $$ BEGIN
  ALTER TABLE sites ADD COLUMN IF NOT EXISTS agency_id INTEGER REFERENCES agencies(id) ON DELETE SET NULL;
  ALTER TABLE sites ADD COLUMN IF NOT EXISTS business_info JSONB;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Teams: appartengono a una location/site.
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_team_site_name UNIQUE(site_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS teams_external_id_key
  ON teams(external_id) WHERE external_id IS NOT NULL;

-- Team Members: associazione utenti a team.
CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'member',
  CONSTRAINT uq_team_member UNIQUE(team_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS team_members_external_id_key
  ON team_members(external_id) WHERE external_id IS NOT NULL;

-- User Locations: associazione utenti a location/site (supporto multi-site).
CREATE TABLE IF NOT EXISTS user_locations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  CONSTRAINT uq_user_location UNIQUE(user_id, site_id)
);
