CREATE TABLE IF NOT EXISTS form_submissions (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  form_slug VARCHAR(255) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_site_slug ON form_submissions(site_id, form_slug);
CREATE INDEX IF NOT EXISTS idx_form_submissions_created ON form_submissions(created_at DESC);
