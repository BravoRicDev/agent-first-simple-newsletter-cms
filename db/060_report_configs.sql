-- Feature 41 — Report periodici ai clienti.
--
-- Una config per sito definisce un report automatico ('weekly' | 'monthly')
-- con le sezioni da includere (whitelist: leads, pipeline, tasks,
-- conversations, email) e i destinatari email. La generazione raccoglie
-- conteggi/aggregati CRM con query dirette (nessuna dipendenza da
-- dashboard.js) e produce { json, html }; l'invio passa da
-- src/services/email.js (sendEmail) e ogni esecuzione registra una riga in
-- report_runs (status 'ok' | 'error') così l'agente può verificare l'esito.
-- Idempotente: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS report_configs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'weekly'
    CHECK (kind IN ('weekly','monthly')),
  sections JSONB NOT NULL DEFAULT '["leads","pipeline","tasks"]',
  recipients JSONB NOT NULL DEFAULT '[]',
  last_sent_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_configs_site_active
  ON report_configs(site_id, active);

CREATE TABLE IF NOT EXISTS report_runs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  config_id INTEGER REFERENCES report_configs(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok','error')),
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_runs_config_created
  ON report_runs(config_id, created_at DESC);
