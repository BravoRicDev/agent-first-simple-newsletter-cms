-- ONDA 2 — Booking Calendar Sync: collegamento booking ↔ Google Calendar.
--
-- Config per-tenant che collega i booking (tabella booking_appointments, 077)
-- a un calendario Google tramite la connessione OAuth (feature 36, 055).
-- La sincronizzazione è unidirezionale OUT (booking → eventi Google Calendar):
-- quando un booking viene creato, viene creato un evento nel calendario;
-- quando un booking viene cancellato, l'evento viene rimosso.
--
-- Senza config (o senza connessione OAuth attiva) il sync NON parte:
-- booking.create/cancel funziona normalmente senza Google Calendar.
-- NESSUNA migrazione dati (la tabella parte vuota).
CREATE TABLE IF NOT EXISTS booking_calendar_config (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- Riferimento alla connessione OAuth (oauth_connections.id). Nessuna FK:
  -- la tabella oauth_connections arriva con la feature 36 (migrazione 055)
  -- e potrebbe non esistere ancora. Il riferimento è verificato a runtime.
  oauth_connection_id INTEGER NOT NULL,
  calendar_id VARCHAR(255) NOT NULL DEFAULT 'primary',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_calendar_config_site
  ON booking_calendar_config(site_id, active);