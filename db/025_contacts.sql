-- CRM-lite: tabella persistente per tag/stato/note sui contatti. Separata
-- dall'aggregazione calcolata al volo in services/contacts.js (che resta la
-- fonte per formsCount/total/firstSeen/lastSeen, derivati da
-- form_submissions) — qui viene salvato solo ciò che non è derivabile dai
-- dati inviati: tag assegnati a mano, stato pipeline, note libere.
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status VARCHAR(100) NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, email)
);
CREATE INDEX IF NOT EXISTS idx_contacts_site_id ON contacts(site_id);
CREATE INDEX IF NOT EXISTS idx_contacts_tags ON contacts USING GIN(tags);

-- Segmentazione per tag: NULL = comportamento invariato (tutti gli iscritti
-- confermati, come oggi), valorizzato = solo i contatti con quel tag.
ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS target_tag VARCHAR(100);
ALTER TABLE newsletter_sequences ADD COLUMN IF NOT EXISTS target_tag VARCHAR(100);

-- Se valorizzato, deve essere la chiave di un campo checkbox del form: alla
-- compilazione, se quel checkbox è spuntato e un'email è identificata,
-- iscrive automaticamente alla newsletter del sito (stesso doppio opt-in
-- dell'iscrizione manuale, l'email di conferma parte comunque).
ALTER TABLE forms ADD COLUMN IF NOT EXISTS newsletter_optin_key VARCHAR(100);
