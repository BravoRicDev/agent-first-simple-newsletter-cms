-- Note lead + conversazioni (email/WhatsApp).
-- Fino a oggi un contatto aveva UN solo campo `notes` (testo libero in
-- contacts.notes, sovrascritto a ogni modifica). Qui introduciamo una
-- timeline di note multiple, ognuna con autore e tipo (umano/agente/sistema).
CREATE TABLE IF NOT EXISTS contact_notes (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  contact_email VARCHAR(255) NOT NULL,
  author_type VARCHAR(20) NOT NULL DEFAULT 'human',  -- human | agent | system
  author_name VARCHAR(100) NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact
  ON contact_notes(site_id, contact_email, created_at DESC);

-- Conversazioni: un thread per contatto+canale (email/whatsapp). Il canale
-- whatsapp è pensato per l'integrazione con un bot WhatsApp esterno (Baileys):
-- il CMS non invia WhatsApp da solo, ma registra i messaggi in/out che gli
-- arrivano via API agente/MCP così la storia del lead sta tutta in un posto.
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  contact_email VARCHAR(255) NOT NULL,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email','whatsapp')),
  status VARCHAR(20) NOT NULL DEFAULT 'open',  -- open | pending | closed
  subject VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, contact_email, channel)
);
CREATE INDEX IF NOT EXISTS idx_conversations_site_status
  ON conversations(site_id, status, updated_at DESC);

-- Messaggi dentro una conversazione (il thread vero e proprio).
CREATE TABLE IF NOT EXISTS conversation_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out')),
  subject VARCHAR(255) NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv
  ON conversation_messages(conversation_id, created_at);
