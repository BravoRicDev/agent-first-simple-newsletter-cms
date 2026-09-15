-- Feature 31 — Agent builder visuale + sandbox di test.
-- Definizioni di agente configurabili via API con dry-run.
--
-- agent_definitions: configurazione riusabile di un agente (prompt, modello,
--   canali, strumenti consentiti, stile di risposta, risposta predefinita,
--   temperatura). Il flag sandbox=true marca le definizioni "in prova":
--   l'agente può testarle senza che vengano usate in produzione.
-- sandbox_runs: storico dei test dry-run (input → output simulato). Ogni run
--   NON scrive conversazioni/task/tag: è solo un registro di valutazione.
CREATE TABLE IF NOT EXISTS agent_definitions (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config JSONB NOT NULL DEFAULT '{}',
  sandbox BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_definitions_site_active
  ON agent_definitions(site_id, active);

CREATE TABLE IF NOT EXISTS sandbox_runs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  agent_definition_id INTEGER REFERENCES agent_definitions(id) ON DELETE SET NULL,
  kind VARCHAR(50) NOT NULL DEFAULT 'agent_test',
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_site_created
  ON sandbox_runs(site_id, created_at DESC);
