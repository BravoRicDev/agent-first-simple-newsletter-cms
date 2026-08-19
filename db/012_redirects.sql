CREATE TABLE IF NOT EXISTS redirects (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  code INTEGER NOT NULL DEFAULT 301 CHECK (code IN (301, 302, 307, 308)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, from_path)
);

CREATE INDEX IF NOT EXISTS idx_redirects_site_id_from ON redirects(site_id, from_path);
