CREATE TABLE IF NOT EXISTS social_posts (
  id SERIAL PRIMARY KEY,
  page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('twitter','linkedin','facebook')),
  message TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_posts_due ON social_posts(posted_at, scheduled_at) WHERE posted_at IS NULL;
