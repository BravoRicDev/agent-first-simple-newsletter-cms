-- Google Calendar sync per le calls (calendar-sync.js): serve un campo per
-- ricordare l'evento Google già creato, così pushCallsToCalendar() non lo
-- ricrea duplicato a ogni syncNow() ma aggiorna/skippa le calls già pushate.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255);
