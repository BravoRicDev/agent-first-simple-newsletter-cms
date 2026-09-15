ALTER TABLE newsletter_settings ADD COLUMN IF NOT EXISTS signature_html TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS newsletter_sequences (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_newsletter_sequences_site ON newsletter_sequences(site_id);

-- delay_days e' relativo a newsletter_subscribers.confirmed_at (non allo
-- step precedente): evita drift cumulativo, pattern "giorno 0/3/7 dalla
-- conferma". L'ordine stretto tra step e' garantito a livello applicativo
-- (src/services/newsletter.js), non dallo schema.
CREATE TABLE IF NOT EXISTS newsletter_sequence_steps (
  id SERIAL PRIMARY KEY,
  sequence_id INTEGER NOT NULL REFERENCES newsletter_sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,
  subject VARCHAR(500) NOT NULL,
  html_content TEXT NOT NULL DEFAULT '',
  UNIQUE(sequence_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_newsletter_sequence_steps_seq ON newsletter_sequence_steps(sequence_id, step_order);

CREATE TABLE IF NOT EXISTS newsletter_sequence_sends (
  id SERIAL PRIMARY KEY,
  step_id INTEGER NOT NULL REFERENCES newsletter_sequence_steps(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  open_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(step_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS idx_newsletter_sequence_sends_step ON newsletter_sequence_sends(step_id);
