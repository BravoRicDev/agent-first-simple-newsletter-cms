-- ONDA 1 — Core CRM: storage per valori custom field dei contatti + follower.
-- Idempotente (IF NOT EXISTS). NESSUNA migrazione dati: struttura pronta per
-- l'import (le tabelle partono vuote).
CREATE TABLE IF NOT EXISTS contact_custom_values (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  object_key VARCHAR(100) NOT NULL DEFAULT 'contact',
  values JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, contact_id, object_key)
);
CREATE INDEX IF NOT EXISTS idx_contact_custom_values_site
  ON contact_custom_values(site_id, contact_id);

-- Follower di un contatto (utenti che seguono il contatto). Struttura pronta
-- per v1; gli endpoint /followers possono restare minimali.
CREATE TABLE IF NOT EXISTS contact_followers (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, contact_id, user_id)
);
