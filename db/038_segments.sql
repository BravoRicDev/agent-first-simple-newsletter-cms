-- 1) Eventi contatto: storico centralizzato di OGNI azione significativa.
-- Alimenta segmenti (F1), workflow (F2), scoring (F4), timeline e GDPR.
CREATE TABLE IF NOT EXISTS contact_events (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,  -- form_submitted|quiz_completed|email_opened|email_clicked|call_booked|call_status_changed|stage_changed|tag_added|contact_created|manual
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_events_site_email ON contact_events(site_id, email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_events_type ON contact_events(site_id, event_type, created_at DESC);

-- 2) Segmenti dinamici: query salvate sui contatti. Le regole sono JSONB e
-- vengono valutate da src/services/segments.js (whitelist campi/operatori,
-- mai interpolazione SQL). La membership è materializzata in segment_members
-- e aggiornata incrementalmente a ogni evento.
CREATE TABLE IF NOT EXISTS segments (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules JSONB NOT NULL DEFAULT '[]',
  match_mode VARCHAR(10) NOT NULL DEFAULT 'all',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, name)
);
CREATE INDEX IF NOT EXISTS idx_segments_site ON segments(site_id);

CREATE TABLE IF NOT EXISTS segment_members (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (segment_id, email)
);
CREATE INDEX IF NOT EXISTS idx_segment_members_site_email ON segment_members(site_id, email);
