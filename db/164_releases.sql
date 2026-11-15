-- db/164_releases.sql
CREATE TABLE IF NOT EXISTS releases (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','running','done','failed','cancelled')),
  scheduled_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  result JSONB,
  error TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_releases_due ON releases(scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_releases_site ON releases(site_id, created_at DESC);
CREATE TABLE IF NOT EXISTS release_items (
  id SERIAL PRIMARY KEY,
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK (action IN ('publish','unpublish')),
  base_updated_at TIMESTAMPTZ NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (release_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_release_items_page ON release_items(page_id);
