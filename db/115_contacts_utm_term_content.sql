-- 115: UTM standard completo sui contatti — utm_term + utm_content.
--
-- Lo standard UTM usato da Meta/Google Ads ha 5 parametri:
--   utm_source, utm_medium, utm_campaign (già presenti da 040),
--   utm_term, utm_content (aggiunti qui).
-- Semafori identici agli altri: PRIMA origine vince (COALESCE sul primo
-- contatto), stesso pattern di 040_email_tracking.sql.
--
-- Idempotente.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_term VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_content VARCHAR(255);