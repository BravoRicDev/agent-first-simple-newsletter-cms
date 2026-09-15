-- 107: site_id su social_posts — la tabella legacy è scope via page_id (che
-- può essere NULL), il clone API richiede tenancy esplicita per tenant.
-- I post legacy (site_id NULL) restano invisibili alle API clone.
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS site_id INT REFERENCES sites(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_social_posts_site ON social_posts(site_id);
