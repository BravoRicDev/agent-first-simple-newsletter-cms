-- db/163_editorial_workflow.sql
ALTER TABLE pages ADD COLUMN IF NOT EXISTS editorial_status VARCHAR(20);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS editorial_updated_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_editorial_status_check') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_editorial_status_check
      CHECK (editorial_status IS NULL OR editorial_status IN ('draft','in_review','approved','rejected','published'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pages_editorial_status ON pages(site_id, editorial_status) WHERE editorial_status IS NOT NULL;
CREATE TABLE IF NOT EXISTS page_reviews (
  id SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_label VARCHAR(255) NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_page_reviews_page ON page_reviews(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_reviews_site ON page_reviews(site_id, created_at DESC);
CREATE OR REPLACE FUNCTION pages_editorial_reset() RETURNS trigger AS $$
BEGIN
  IF OLD.editorial_status IN ('approved','in_review')
     AND NEW.editorial_status IS NOT DISTINCT FROM OLD.editorial_status
     AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.title IS DISTINCT FROM OLD.title) THEN
    NEW.editorial_status := 'draft';
    NEW.editorial_updated_at := NOW();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pages_editorial_reset ON pages;
CREATE TRIGGER trg_pages_editorial_reset BEFORE UPDATE OF content, title ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_editorial_reset();
