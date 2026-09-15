CREATE TABLE IF NOT EXISTS ingest_log (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL,
  result_type VARCHAR(50),
  title TEXT,
  word_count INTEGER,
  media_urls_found INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
