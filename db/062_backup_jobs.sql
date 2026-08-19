-- Feature 43 — Backup automatici con storico.
--
-- Ogni backup (automatico dallo scheduler o manuale via API agente) viene
-- registrato in backup_jobs: l'admin vede TUTTI i tentativi, anche quelli
-- falliti (status 'failed' con error), così un pg_dump mancante o un
-- timeout non spariscono nel nulla ma restano ispezionabili.
--   site_id     NULL = backup globale (intero DB / tutta la media)
--   kind        'full' (db+media) | 'db' | 'media'
--   status      'running' | 'done' | 'failed'
--   created_by  'system' (scheduler) | 'manual' (API agente)
-- file_path è relativo alla root del progetto e inizia con 'backups/' per
-- i file fisici (la delete del job rimuove anche il file, solo se il path
-- inizia con backups/ — mai fuori da quella cartella).
CREATE TABLE IF NOT EXISTS backup_jobs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,  -- NULL = globale
  kind VARCHAR(20) NOT NULL DEFAULT 'full',   -- full | db | media
  status VARCHAR(20) NOT NULL DEFAULT 'running', -- running | done | failed
  file_path TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(50) NOT NULL DEFAULT 'system', -- system | manual
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_backup_jobs_site_created
  ON backup_jobs(site_id, created_at DESC);
