-- 124: nuove tabelle per l'estensione di copertura del source-sync
-- (richiesta cliente: "tutto il leggibile via API deve poter essere
-- copiato nel CMS") — workflow GHL, funnel, custom values di location,
-- dettagli location/business.
--
-- Prefisso "ghl_" scelto apposta per "ghl_workflows": non va confuso con
-- la tabella `workflows` del motore "Automazioni v2" del CMS
-- (src/services/workflows.js) — sono due sistemi distinti, uno copia dati
-- in sola lettura dal CRM sorgente, l'altro è il motore di automazione
-- nativo del CMS. Stesso discorso per ogni altra tabella qui sotto.
--
-- ghl_workflows/ghl_funnels/ghl_custom_values usano il doppio id (ghl_id,
-- vedi db/120_ghl_id_columns.sql) e passano da upsertByExternalId: servono
-- site_id + created_at/updated_at, stesso schema minimo già usato dalle
-- altre tabelle del source-sync.
--
-- ghl_location_info è un caso diverso: un solo record per sito (i
-- "dettagli location/business" del CRM sorgente sono singolari, non una
-- lista), quindi site_id è la chiave primaria e l'upsert è un semplice
-- ON CONFLICT(site_id), non upsertByExternalId.

CREATE TABLE IF NOT EXISTS ghl_workflows (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ghl_id VARCHAR(255) NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status VARCHAR(50) NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ghl_workflows_ghl_id ON ghl_workflows(ghl_id) WHERE ghl_id <> '';
CREATE INDEX IF NOT EXISTS idx_ghl_workflows_site ON ghl_workflows(site_id);

CREATE TABLE IF NOT EXISTS ghl_funnels (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ghl_id VARCHAR(255) NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  -- Struttura ricca e nidificata (step di pagina): copiata integrale in
  -- JSONB invece di modellata relazionalmente, stessa scelta già fatta per
  -- ghl_workflows.payload.
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ghl_funnels_ghl_id ON ghl_funnels(ghl_id) WHERE ghl_id <> '';
CREATE INDEX IF NOT EXISTS idx_ghl_funnels_site ON ghl_funnels(site_id);

-- Custom Values (location-level): concetto DISTINTO dai Custom Fields
-- per-contatto (tabella custom_fields, già sincronizzati) — merge tag
-- globali usati in template/workflow del CRM sorgente.
CREATE TABLE IF NOT EXISTS ghl_custom_values (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ghl_id VARCHAR(255) NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ghl_custom_values_ghl_id ON ghl_custom_values(ghl_id) WHERE ghl_id <> '';
CREATE INDEX IF NOT EXISTS idx_ghl_custom_values_site ON ghl_custom_values(site_id);

-- Dettagli Location/Business (GET /locations/{id}): un record per sito.
-- Sotto-prodotto utile: company_id qui sblocca la sync utenti (GET
-- /users/search la richiede, vedi mappers/users.js) quando l'account non
-- l'ha mai configurata esplicitamente su source_sync_config.
CREATE TABLE IF NOT EXISTS ghl_location_info (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  ghl_id VARCHAR(255) NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city VARCHAR(255) NOT NULL DEFAULT '',
  state VARCHAR(255) NOT NULL DEFAULT '',
  postal_code VARCHAR(50) NOT NULL DEFAULT '',
  country VARCHAR(100) NOT NULL DEFAULT '',
  phone VARCHAR(50) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  timezone VARCHAR(100) NOT NULL DEFAULT '',
  company_id VARCHAR(64) NOT NULL DEFAULT '',
  raw JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
