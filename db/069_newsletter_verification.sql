-- Igiene lista newsletter: validazione email all'iscrizione (BLOCCO A).
-- Aggiunge colonne di verifica per tracciare quali email hanno superato i controlli anti-spam.
-- Valori verification: 'pending' (default per iscritti legacy), 'passed' (ok), 'role' (role-based B2B), 'blocked' (spam/no-reply/disposable/no MX).

ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS verification TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Constraint: verification può avere solo questi valori.
-- PostgreSQL NON supporta "ADD CONSTRAINT IF NOT EXISTS" (a differenza di ADD
-- COLUMN): uso un DO block per rendere la migrazione idempotente, altrimenti
-- il runner riprova 069 a ogni boot e blocca la catena 070-072.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_newsletter_subscribers_verification'
  ) THEN
    ALTER TABLE newsletter_subscribers ADD CONSTRAINT ck_newsletter_subscribers_verification
      CHECK (verification IN ('pending', 'passed', 'role', 'blocked'));
  END IF;
END $$;

-- Indice per query quick-wins (subscribers già verificati).
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_verification
  ON newsletter_subscribers(site_id, verification, verified_at DESC);
