-- Igiene lista newsletter: validazione email all'iscrizione (BLOCCO A).
-- Aggiunge colonne di verifica per tracciare quali email hanno superato i controlli anti-spam.
-- Valori verification: 'pending' (default per iscritti legacy), 'passed' (ok), 'role' (role-based B2B), 'blocked' (spam/no-reply/disposable/no MX).

ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS verification TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Constraint: verification può avere solo questi valori.
ALTER TABLE newsletter_subscribers ADD CONSTRAINT IF NOT EXISTS ck_newsletter_subscribers_verification
  CHECK (verification IN ('pending', 'passed', 'role', 'blocked'));

-- Indice per query quick-wins (subscribers già verificati).
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_verification
  ON newsletter_subscribers(site_id, verification, verified_at DESC);
