-- Feature 39 — Export/import completo del CRM (JSON/CSV).
--
-- Ogni operazione di import (contatti singoli o CRM completo con task)
-- crea una riga in import_jobs: log persistente e ispezionabile via API
-- agente con stato, statistiche (imported/skipped/errors) e, in caso di
-- errore, il messaggio del primo problema. kind distingue i due flussi:
--   'contacts' → solo contatti (upsert per email)
--   'crm'      → contatti + task in un unico job
-- filename resta vuoto per gli import via API (i file CSV lato server non
-- vengono mai salvati: l'export CSV è generato al volo e scaricato).
CREATE TABLE IF NOT EXISTS import_jobs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL DEFAULT 'contacts',   -- contacts | crm
  filename VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | done | failed
  stats JSONB NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_site_created
  ON import_jobs(site_id, created_at DESC);
