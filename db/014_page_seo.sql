CREATE TABLE IF NOT EXISTS page_seo (
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE PRIMARY KEY,
  meta_title VARCHAR(255),
  meta_description TEXT,
  meta_keywords TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
