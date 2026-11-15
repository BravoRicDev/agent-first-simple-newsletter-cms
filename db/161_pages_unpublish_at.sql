-- db/161_pages_unpublish_at.sql
ALTER TABLE pages ADD COLUMN IF NOT EXISTS unpublish_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_pages_unpublish_at ON pages(unpublish_at) WHERE unpublish_at IS NOT NULL AND published = true;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS unpublish_at TIMESTAMPTZ;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS card_title TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS reading_time_minutes INTEGER;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS card_html_override TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS author_id INTEGER;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS source VARCHAR(20);
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS label VARCHAR(255);
