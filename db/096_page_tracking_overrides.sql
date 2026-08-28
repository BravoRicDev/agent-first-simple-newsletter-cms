CREATE TABLE IF NOT EXISTS page_tracking_overrides (
  page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  pixel_enabled BOOLEAN,   -- NULL = eredita dal sito (default: attivo)
  track_pageview BOOLEAN,  -- NULL = eredita (default attuale: PageView sempre su consenso)
  track_lead BOOLEAN,      -- NULL = eredita (default attuale: leadPages/leadEventName del sito)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);