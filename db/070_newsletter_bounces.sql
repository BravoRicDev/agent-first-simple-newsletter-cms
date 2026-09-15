-- BLOCCO B: Gestione bounce email. Cattura e classifica rimbalzi SMTP,
-- supprime indirizzi morti (hard bounce) e indirizzi con troppi soft bounce.

-- Aggiungere colonne di tracciamento bounce a newsletter_subscribers.
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS bounce_hard INT NOT NULL DEFAULT 0;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS bounce_soft INT NOT NULL DEFAULT 0;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS last_bounce_at TIMESTAMPTZ;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS suppression_reason VARCHAR(20);

-- Estendere il CHECK constraint di status per includere 'bounced' e 'suppressed'.
-- Postgres non permette di modificare un constraint esistente — bisogna dropparlo e ricrearlo.
-- IF NOT EXISTS per il drop è idempotente in PG 10+, ma il nome del constraint deve essere esatto.
-- Pattern: <table>_<column>_check per i constraint anonimi creati da CHECK(...).
ALTER TABLE newsletter_subscribers DROP CONSTRAINT IF EXISTS newsletter_subscribers_status_check;
ALTER TABLE newsletter_subscribers ADD CONSTRAINT newsletter_subscribers_status_check
  CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'bounced', 'suppressed'));

-- Tabella storica di bounce: ogni evento di rimbalzo viene registrato qui per audit/analytics.
CREATE TABLE IF NOT EXISTS newsletter_bounces (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subscriber_id INTEGER REFERENCES newsletter_subscribers(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('hard', 'soft')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_bounces_site ON newsletter_bounces(site_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_bounces_subscriber ON newsletter_bounces(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_bounces_email ON newsletter_bounces(email);
CREATE INDEX IF NOT EXISTS idx_newsletter_bounces_created ON newsletter_bounces(created_at DESC);
