-- Performance indexes for common query patterns: sequential scan elimination
-- on tables that grow over time. All IF NOT EXISTS: idempotent and safe to re-run.

-- magic_links: DELETE di pulizia a ogni login (magic-link.js) filtra per
-- expires_at; token è usato come lookup esatto ma l'indice non è univoco.
CREATE INDEX IF NOT EXISTS idx_magic_links_expires_at ON magic_links (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links (token);

-- pages: lo scheduler ogni 60s cerca pagine con review_at dovuta e reminder
-- non inviato (scheduler.js) — indice parziale su (review_at, reminder_sent).
CREATE INDEX IF NOT EXISTS idx_pages_review_reminder
  ON pages (review_at, reminder_sent) WHERE review_at IS NOT NULL;

-- calls: lo scheduler ogni 60s cerca chiamate programmate con promemoria
-- non inviato (calls.js) — indice parziale su (status, reminder_sent_at).
CREATE INDEX IF NOT EXISTS idx_calls_reminder
  ON calls (status, reminder_sent_at) WHERE reminder_sent_at IS NULL;

-- ingest_log: la pagina /admin/agent ordina per created_at DESC LIMIT 20.
CREATE INDEX IF NOT EXISTS idx_ingest_log_created_at ON ingest_log (created_at);

-- social_posts: FK page_id mai indicizzata, usata in query per pagina.
CREATE INDEX IF NOT EXISTS idx_social_posts_page_id ON social_posts (page_id);

-- users: WHERE u.site_id = $1 in dashboard, gestione utenti e scheduler.
CREATE INDEX IF NOT EXISTS idx_users_site_id ON users (site_id);
