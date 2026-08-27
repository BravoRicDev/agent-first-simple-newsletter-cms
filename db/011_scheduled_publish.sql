ALTER TABLE pages ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS review_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_pages_publish_at ON pages(publish_at) WHERE publish_at IS NOT NULL AND published = false;
