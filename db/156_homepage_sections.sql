CREATE TABLE IF NOT EXISTS homepage_sections (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  section_type VARCHAR(30) NOT NULL CHECK (section_type IN ('custom_html','category_band','category_feed','all_feed')),
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL DEFAULT '',
  articles_limit INTEGER NOT NULL DEFAULT 6,
  custom_html TEXT NOT NULL DEFAULT '',
  card_template_override TEXT,
  enable_client_filter BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_homepage_sections_site_id ON homepage_sections(site_id, position);

ALTER TABLE categories ADD COLUMN IF NOT EXISTS color VARCHAR(20);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon VARCHAR(10);
