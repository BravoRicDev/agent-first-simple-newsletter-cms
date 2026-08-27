-- Migration: compatibilita con il modulo satellite collego-sales
-- 1) opportunities: owner (setter assegnato) e contatto denormalizzato
-- 2) users: colonna surname + ruoli setter/closer per il modulo sales

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS contact_company VARCHAR(255) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON opportunities(owner_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_site_status ON opportunities(site_id, status);

ALTER TABLE users ADD COLUMN IF NOT EXISTS surname VARCHAR(255) NOT NULL DEFAULT '';

-- Estende il CHECK sui ruoli aggiungendo setter e closer (usati dal sales).
-- Idempotente: interviene solo se il constraint attuale non li contiene.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'users'
      AND c.conname = 'users_role_check'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%setter%'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('superadmin','admin','collaboratore','setter','closer'));
  END IF;
END $$;
