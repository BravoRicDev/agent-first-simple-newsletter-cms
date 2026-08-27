-- ONDA 2 — Booking system: appuntamenti prenotati dai contatti.
-- Tabella dedicata alle prenotazioni (booking) per-tenant, con supporto
-- futuro per Google Calendar sync (google_event_id). Idempotente.
-- NESSUNA migrazione dati (la tabella parte vuota).
CREATE TABLE IF NOT EXISTS booking_appointments (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  contact_name VARCHAR(255) NOT NULL DEFAULT '',
  contact_email VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(50) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'confirmed',
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  google_event_id VARCHAR(255) DEFAULT NULL,
  cancelled_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_appts_site
  ON booking_appointments(site_id, status, start_time);
CREATE INDEX IF NOT EXISTS idx_booking_appts_email
  ON booking_appointments(site_id, contact_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_appts_google_event
  ON booking_appointments(google_event_id) WHERE google_event_id IS NOT NULL;