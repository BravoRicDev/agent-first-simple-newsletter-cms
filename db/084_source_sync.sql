-- 084: Source Sync — import/sincronizzazione dal CRM sorgente.
-- Tabella di configurazione per-tenant (token cifrato con encryptSecret(),
-- v. services/crypto.js) e tabelle di stato/storico dei run.
-- Idempotente: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS source_sync_config (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  base_url VARCHAR(500) NOT NULL DEFAULT '',
  location_id VARCHAR(64) NOT NULL DEFAULT '',
  company_id VARCHAR(64) NOT NULL DEFAULT '',
  token_enc VARCHAR(500),
  match_by_email BOOLEAN NOT NULL DEFAULT true,
  handle_deletes BOOLEAN NOT NULL DEFAULT false,
  throttle_rps INT NOT NULL DEFAULT 8,
  daily_quota INT NOT NULL DEFAULT 250000,
  budget_percent INT NOT NULL DEFAULT 30,
  min_interval_minutes INT NOT NULL DEFAULT 15,
  calls_date DATE,
  calls_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Watermark/statistiche per tipo risorsa (monitoraggio + future ottimizzazioni)
CREATE TABLE IF NOT EXISTS source_sync_state (
  site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  resource_type VARCHAR(50) NOT NULL,
  watermark TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status VARCHAR(20),
  last_counts JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (site_id, resource_type)
);

-- Storico run con stats per risorsa e errori recenti
CREATE TABLE IF NOT EXISTS source_sync_runs (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  mode VARCHAR(20) NOT NULL DEFAULT 'full',
  resources TEXT[],
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}',
  errors JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_source_sync_runs_site ON source_sync_runs(site_id, started_at DESC);

-- company_id (identificativo agenzia del CRM sorgente), richiesto da
-- GET /users/search: l'endpoint legacy GET /users?locationId è deprecato
-- sull'API attuale — vedi doc API sorgente versione 2021-07-28
-- ("Deprecated. Use GET /users/search instead"), che richiede companyId
-- oltre a locationId.
ALTER TABLE source_sync_config ADD COLUMN IF NOT EXISTS company_id VARCHAR(64) NOT NULL DEFAULT '';
