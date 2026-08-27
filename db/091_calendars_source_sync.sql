-- 091: colonne e tabelle per il mapper source-sync "calendars" (e sync
-- appuntamenti), copiate da db/096_calendars_clone.sql del repo sorgente.
-- Il mapper scrive calendars(timezone) e booking_appointments(calendar_id,
-- appointment_status) e popola calendar_members dal team. Idempotente.

ALTER TABLE calendars ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NULL;
ALTER TABLE calendars ADD COLUMN IF NOT EXISTS appointment_notifications JSONB NULL;

CREATE TABLE IF NOT EXISTS calendar_members (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_calendar_member UNIQUE(calendar_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_members_site ON calendar_members(site_id);
CREATE INDEX IF NOT EXISTS idx_calendar_members_calendar ON calendar_members(calendar_id);
CREATE INDEX IF NOT EXISTS idx_calendar_members_user ON calendar_members(user_id);

ALTER TABLE booking_appointments ADD COLUMN IF NOT EXISTS calendar_id INTEGER REFERENCES calendars(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_booking_appts_calendar ON booking_appointments(calendar_id);

ALTER TABLE booking_appointments ADD COLUMN IF NOT EXISTS appointment_status VARCHAR(20) NULL;
CREATE INDEX IF NOT EXISTS idx_booking_appts_appointment_status
  ON booking_appointments(site_id, appointment_status) WHERE appointment_status IS NOT NULL;
