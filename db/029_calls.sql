-- Modulo chiamate: disponibilità settimanale ricorrente (per calcolare gli
-- slot prenotabili pubblicamente) + le chiamate vere e proprie, sia
-- prenotate dal pubblico (booking_token valorizzato) sia programmate a mano
-- dall'admin dalla scheda contatto (booking_token NULL).
CREATE TABLE IF NOT EXISTS call_availability (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_availability_site ON call_availability(site_id);

CREATE TABLE IF NOT EXISTS calls (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  status VARCHAR(30) NOT NULL DEFAULT 'programmata' CHECK (status IN ('programmata','completata','no_show','annullata')),
  outcome_notes TEXT NOT NULL DEFAULT '',
  booking_token VARCHAR(64) UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calls_site_scheduled ON calls(site_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_calls_site_email ON calls(site_id, email);
