-- Override per-pagina della durata (in ore) dei cookie di consenso
-- (consent_analytics / consent_marketing). NULL = eredita dal sito
-- (settings.tracking_consent_cookie_hours, default 1 ora — vedi
-- src/services/tracking.js). Stesso schema tri-state delle altre colonne
-- di questa tabella (NULL = eredita).
ALTER TABLE page_tracking_overrides
  ADD COLUMN IF NOT EXISTS consent_cookie_hours INTEGER;
