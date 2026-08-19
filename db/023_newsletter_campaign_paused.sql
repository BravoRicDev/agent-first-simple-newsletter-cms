-- Prima non c'era alcun modo di fermare una campagna broadcast già in invio:
-- il CHECK ammetteva solo draft/sending/sent. Aggiunge 'paused'.
ALTER TABLE newsletter_campaigns DROP CONSTRAINT IF EXISTS newsletter_campaigns_status_check;
ALTER TABLE newsletter_campaigns ADD CONSTRAINT newsletter_campaigns_status_check
  CHECK (status IN ('draft', 'sending', 'sent', 'paused'));
