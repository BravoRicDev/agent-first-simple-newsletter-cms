-- Open/click tracking email + UTM sorgente contatto.
-- Gli open restano su newsletter_sends.opened_at (esistente, compatibilità);
-- qui registriamo eventi granulari (click con URL, e open come evento
-- per timeline/workflow/scoring).
CREATE TABLE IF NOT EXISTS newsletter_send_events (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  send_id INTEGER NOT NULL,
  kind VARCHAR(10) NOT NULL DEFAULT 'campaign',  -- 'campaign'|'sequence'
  event_type VARCHAR(10) NOT NULL,               -- 'open'|'click'
  url TEXT NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nl_send_events_email ON newsletter_send_events(site_id, email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nl_send_events_send ON newsletter_send_events(send_id, kind);

-- UTM sorgente: settata al PRIMO contatto (prima origine vince).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_source VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_source VARCHAR(255) NOT NULL DEFAULT '';

-- Target per segmento sulle campagne/sequenze (oltre a target_tag).
ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS target_segment_id INTEGER
  REFERENCES segments(id) ON DELETE SET NULL;
ALTER TABLE newsletter_sequences ADD COLUMN IF NOT EXISTS target_segment_id INTEGER
  REFERENCES segments(id) ON DELETE SET NULL;
