CREATE TABLE IF NOT EXISTS bug_reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  steps_to_reproduce TEXT NOT NULL DEFAULT '',
  expected_behavior TEXT NOT NULL DEFAULT '',
  actual_behavior TEXT NOT NULL DEFAULT '',
  mockup_before_html TEXT NOT NULL DEFAULT '',
  mockup_after_html TEXT NOT NULL DEFAULT '',
  browser_info TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aperto'
    CHECK (status IN ('aperto','in_lavorazione','risolto','chiuso')),
  priority TEXT NOT NULL DEFAULT 'normale'
    CHECK (priority IN ('bassa','normale','alta','critica')),
  note_sviluppatore TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id ON bug_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
