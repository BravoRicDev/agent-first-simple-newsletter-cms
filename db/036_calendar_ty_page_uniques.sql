-- 1) Vincolo UNIQUE su call_availability: nessun vincolo prima → doppi
-- inserimenti creavano duplicati (capitato: 19 righe duplicate, pulite a
-- mano). Prima si deduplicano le righe esistenti (si tiene il MIN(id) per
-- ogni gruppo), poi si crea l'indice unico. calendar_id è NULL per le
-- regole site-wide: COALESCE(calendar_id, 0) fa sì che due righe "generali"
-- con stesso giorno/ora collidano (0 == NULL normalizzato), mentre
-- calendari diversi possono avere lo stesso orario (indipendenza agenda).
DELETE FROM call_availability a
  USING call_availability b
  WHERE a.id > b.id
    AND a.site_id = b.site_id
    AND a.weekday = b.weekday
    AND a.start_time = b.start_time
    AND a.end_time = b.end_time
    AND a.slot_minutes = b.slot_minutes
    AND COALESCE(a.calendar_id, 0) = COALESCE(b.calendar_id, 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_availability_slot
  ON call_availability (site_id, COALESCE(calendar_id, 0), weekday, start_time);

-- 2) ty_page per calendario: pagina di ringraziamento (thank-you) dopo una
-- prenotazione riuscita su QUEL calendario. Path relativo (es. /grazie) o
-- URL stesso dominio, come forms.redirect_url; vuoto = messaggio di
-- conferma standard. Esposta in UI admin, route agent e tool MCP.
ALTER TABLE calendars ADD COLUMN IF NOT EXISTS ty_page VARCHAR(500);
