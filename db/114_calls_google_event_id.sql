-- 114: calls.google_event_id — idempotenza del push verso Google Calendar.
--
-- Il push out (calendar-sync) ri-POSTava tutti gli eventi a ogni sync:
-- senza salvare l'event_id Google (nessuna colonna), ogni sync manuale
-- ripetuto creava duplicati nel calendario. Con google_event_id il push
-- fa UPDATE dell'evento esistente (PUT) e solo POST se non esiste ancora.
--
-- Idempotente.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_calls_google_event_id
  ON calls(google_event_id) WHERE google_event_id IS NOT NULL;