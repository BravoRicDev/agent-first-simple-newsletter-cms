-- Task vendite: to-do assegnati agli utenti, opzionalmente legati a un
-- contatto (email) — es. "chiama questo lead entro domani".
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL DEFAULT '',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_site_status ON tasks(site_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_email ON tasks(site_id, email);

-- Funnel snapshot: conversione giornaliera per canale (utm_source).
CREATE TABLE IF NOT EXISTS funnel_snapshots (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  channel VARCHAR(255) NOT NULL DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE(site_id, day, channel)
);
CREATE INDEX IF NOT EXISTS idx_funnel_snapshots_site_day ON funnel_snapshots(site_id, day);
