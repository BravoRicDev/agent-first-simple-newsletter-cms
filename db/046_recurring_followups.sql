-- Feature 27: Task ricorrenti + follow-up intelligente.
-- - recurring_tasks: template di task che viene rigenerato a scadenza
--   (daily/weekly/monthly/custom) in righe della tabella `tasks`.
-- - followup_rules: regola "aspetta risposta → se N giorni senza risposta
--   avvisa": trova conversazioni il cui ultimo messaggio è outbound e vecchio
--   di wait_days, e applica un'azione (create_task | notify_email | add_tag).
-- - followup_runs: log delle esecuzioni, usato anche per l'idempotenza
--   (una regola non ri-scatta finché non arriva un nuovo messaggio in).
CREATE TABLE IF NOT EXISTS recurring_tasks (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cadence VARCHAR(20) NOT NULL DEFAULT 'daily',  -- daily | weekly | monthly | custom
  interval_days INTEGER NOT NULL DEFAULT 1,      -- usato solo se cadence='custom'
  next_due_at TIMESTAMPTZ,
  last_generated_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_due
  ON recurring_tasks(site_id, active, next_due_at);

CREATE TABLE IF NOT EXISTS followup_rules (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  wait_days INTEGER NOT NULL DEFAULT 3,
  channel VARCHAR(20) NOT NULL DEFAULT 'conversation',  -- conversation | email | whatsapp | any
  statuses JSONB NOT NULL DEFAULT '["pending","open"]',
  action_type VARCHAR(30) NOT NULL,  -- create_task | notify_email | add_tag
  action_config JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_followup_rules_site
  ON followup_rules(site_id, active);

CREATE TABLE IF NOT EXISTS followup_runs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  rule_id INTEGER REFERENCES followup_rules(id) ON DELETE CASCADE,
  conversation_id INTEGER,
  email VARCHAR(255),
  action VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ok',  -- ok | error
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_followup_runs_rule_conv
  ON followup_runs(rule_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_followup_runs_site_created
  ON followup_runs(site_id, created_at DESC);
