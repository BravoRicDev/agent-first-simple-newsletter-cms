-- 098 — Clone API, Onda E: campagne broadcast con scheduling, subscriptions,
-- templates. Recuperata da file di lavoro mai committati (vedi nota in
-- 097_clone_sites_columns.sql). Numerata PRIMA di 104+ e di 120 apposta:
-- crea marketing_templates e tocca newsletter_campaigns, entrambe nella
-- lista ALTER TABLE di db/120_ghl_id_columns.sql (che fallisce se la
-- tabella non esiste ancora quando gira).

ALTER TABLE newsletter_campaigns
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS clone_name VARCHAR(255) NULL;

-- Estendi CHECK constraint su status (draft|scheduled|sending|sent|
-- completed|paused). Se esiste già un CHECK diverso lo sostituisce,
-- altrimenti lo crea; idempotente.
DO $$
BEGIN
  BEGIN
    ALTER TABLE newsletter_campaigns
    DROP CONSTRAINT IF EXISTS newsletter_campaigns_status_check;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  ALTER TABLE newsletter_campaigns
  ADD CONSTRAINT newsletter_campaigns_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'completed', 'paused'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Subscriptions contatto↔campagna: materializzazione della relazione con
-- stato attivo (usata da GET/POST/DELETE /campaigns/:id/subscriptions nel
-- clone API).
CREATE TABLE IF NOT EXISTS campaign_subscriptions (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_campaign_subscription UNIQUE(campaign_id, contact_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_subscriptions_external_id
  ON campaign_subscriptions(external_id) WHERE external_id IS NOT NULL;

-- Templates email/SMS per location (distinti dai template di sistema).
CREATE TABLE IF NOT EXISTS marketing_templates (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL DEFAULT 'EMAIL',
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  body_html TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_templates_external_id
  ON marketing_templates(external_id) WHERE external_id IS NOT NULL;
