-- Migrazione ONDA A: colonne nuove su opportunities per il clone API
-- + tabella opportunity_followers con external_id UUID stabile

-- Aggiungi campi su opportunities (idempotente)
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS source VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_status_change TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lost_reason TEXT;

-- Crea tabella follower (un utente "segue" un'opportunità)
CREATE TABLE IF NOT EXISTS opportunity_followers (
  id SERIAL PRIMARY KEY,
  external_id UUID NOT NULL DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_opportunity_follower UNIQUE(opportunity_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_followers_opportunity
  ON opportunity_followers(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_followers_site
  ON opportunity_followers(site_id);
