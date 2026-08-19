-- Lead scoring: punteggio accumulato sul contatto, regole evento→punti,
-- soglie che scatenano azioni (es. cambio stadio).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS scoring_rules (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_filter JSONB NOT NULL DEFAULT '{}',
  points INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scoring_rules_site ON scoring_rules(site_id);

CREATE TABLE IF NOT EXISTS scoring_thresholds (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  min_score INTEGER NOT NULL,
  action_type VARCHAR(50) NOT NULL DEFAULT 'set_stage',
  action_config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(site_id, min_score)
);
CREATE INDEX IF NOT EXISTS idx_scoring_thresholds_site ON scoring_thresholds(site_id);
