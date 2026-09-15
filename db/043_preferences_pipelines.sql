-- Preferenze di contatto: consenso granulare per canale + token pubblico
-- per il centro preferenze (link nelle email).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_email BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_sms BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_phone BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_whatsapp BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_marketing BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_updated_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_token VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_contacts_pref_token ON contacts(pref_token);

-- Pipeline multiple: una board per servizio/nicchia con stadi custom.
CREATE TABLE IF NOT EXISTS pipelines (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  stages JSONB NOT NULL DEFAULT '[]',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, name)
);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pipeline_id INTEGER
  REFERENCES pipelines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_pipeline ON contacts(pipeline_id);
