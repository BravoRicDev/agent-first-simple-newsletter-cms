-- 032_fk_audit_log_indices.sql
-- Foreign key cascade fixes and missing index additions:
-- 1. audit_log.user_id/site_id lacked ON DELETE → DELETE cascades now SET NULL
--    (code already uses LEFT JOIN and handles NULL).
-- 2. idx_magic_links_token: migration from non-unique to UNIQUE constraint
--    (earlier index was non-unique; IF NOT EXISTS prevented override).
-- 3. Missing indexes on hot-path queries (site_domains lookup, ingest_log,
--    newsletter_campaigns status filtering).

-- 1. FK audit_log → ON DELETE SET NULL (idempotente: DROP IF EXISTS + ADD)
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_site_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_site_id_fkey FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;

-- 2. Unicità reale su magic_links.token (drop non-unique, recreate unique)
DROP INDEX IF EXISTS idx_magic_links_token;
CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_links_token_uidx ON magic_links(token);

-- 3. Indici mancanti
CREATE INDEX IF NOT EXISTS idx_site_domains_site_id ON site_domains(site_id);
CREATE INDEX IF NOT EXISTS idx_ingest_log_site_id ON ingest_log(site_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_campaigns_status ON newsletter_campaigns(status);
