-- Fix tracciato (CORREZIONI-TRACCIATE.txt): nessun vincolo UNIQUE su
-- call_availability → doppi inserimenti creano duplicati (es. 19 righe
-- duplicate deduplicate a mano). Aggiunge UNIQUE(site_id, weekday, start_time)
-- con dedup preventivo: se esistono duplicati, tiene la riga con id minore.

DELETE FROM call_availability a
USING call_availability b
WHERE a.id > b.id
  AND a.site_id = b.site_id
  AND a.weekday = b.weekday
  AND a.start_time = b.start_time;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_availability_site_weekday_time
  ON call_availability(site_id, weekday, start_time);
