-- Feature 42 — Sandbox/staging: dry-run di segmenti, workflow, agenti e
-- preventivi con log delle esecuzioni e scenari riutilizzabili.
--
-- sandbox_runs (già in 050_agent_defs.sql) registra ogni esecuzione di
-- dry-run: kind, input, output, created_at. Nessun dry-run scrive
-- contatti/task/conversazioni: è solo un registro di valutazione.
--
-- sandbox_scenarios: definizioni salvate di un dry-run (kind + input JSONB)
-- per rieseguire lo stesso test in un secondo momento (staging). La
-- riesecuzione passa sempre da runSandbox (src/services/sandbox.js) che
-- valida il kind, esegue senza side-effect e registra una riga in
-- sandbox_runs.
-- Idempotente: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS sandbox_scenarios (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(50) NOT NULL
    CHECK (kind IN ('segment','workflow','agent','quote')),
  input JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_scenarios_site_kind
  ON sandbox_scenarios(site_id, kind);
