-- 113: idempotenza invii email dei WORKFLOW (az. send_campaign/send_sequence).
--
-- L'azione del workflow invia la campagna/step ma non registra nulla:
-- la guardia esistente (lettura di newsletter_sends) non scattava mai e la
-- stessa email veniva re-inviata a OGNI evento ripetuto. Tabella dedicata
-- (senza toccare la semantica degli iscritti newsletter) con UNIQUE per
-- (sito, email, tipo, risorsa).
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS workflow_sent_emails (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL,
  email VARCHAR(255) NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('campaign', 'sequence')),
  campaign_id INTEGER,
  step_id INTEGER,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, email, kind, campaign_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_sent_emails_lookup
  ON workflow_sent_emails(site_id, email, kind);