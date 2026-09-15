-- BLOCCO D: Gestione spam complaint. Registra quando un destinatario segnala
-- un'email come spam e supprime immediatamente l'indirizzo.

CREATE TABLE IF NOT EXISTS newsletter_complaints (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'fbl',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_complaints_site ON newsletter_complaints(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_newsletter_complaints_email ON newsletter_complaints(email);
