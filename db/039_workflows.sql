-- Workflow a trigger: regole "se evento → azioni" (tag, stadio, email,
-- task, notifica). trigger_config filtra l'evento (form_slug/quiz_slug/
-- stage/tag/min_score/segment_id). Le azioni sono ordinate; wait_days è
-- solo per la coda differita nel tick scheduler.
CREATE TABLE IF NOT EXISTS workflows (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  trigger_type VARCHAR(50) NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflows_site ON workflows(site_id);

CREATE TABLE IF NOT EXISTS workflow_actions (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  action_order INTEGER NOT NULL,
  action_type VARCHAR(50) NOT NULL,
  action_config JSONB NOT NULL DEFAULT '{}',
  UNIQUE(workflow_id, action_order)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL,
  email VARCHAR(255) NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ok',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_email ON workflow_runs(site_id, email, created_at DESC);

-- Coda differita: azioni wait_days programmate dal workflow engine.
CREATE TABLE IF NOT EXISTS workflow_delayed_actions (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  action_type VARCHAR(50) NOT NULL,
  action_config JSONB NOT NULL DEFAULT '{}',
  run_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_workflow_delayed_due ON workflow_delayed_actions(site_id, status, run_at);
