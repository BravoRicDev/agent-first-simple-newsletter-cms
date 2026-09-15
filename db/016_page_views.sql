CREATE TABLE IF NOT EXISTS page_views (
  id SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  referrer TEXT,
  session_id VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_page_views_page_time ON page_views(page_id, visited_at);
