-- Feature 44 — Quote/rate-limit per canale con avvisi.
--
-- channel_limits: limite configurabile per sito, canale e periodo
--   (canali: 'email'|'whatsapp'|'call'|'sms'|'chat'; periodi: 'hour'|'day').
--   Un solo limite per (site_id, channel, period): vincolo UNIQUE.
--   notify_email valorizzata → al superamento parte un avviso email
--   (una sola volta per periodo, vedi channel_usage.notified).
-- channel_usage: contatore per (site, channel, period, period_start),
--   dove period_start è l'inizio dell'ora/giorno corrente (date_trunc).
--   Le righe dei periodi passati possono essere eliminate da getUsage /
--   resetUsage (manutenzione); nessuna pulizia automatica obbligatoria.
-- Idempotente: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS channel_limits (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL
    CHECK (channel IN ('email','whatsapp','call','sms','chat')),
  period VARCHAR(10) NOT NULL
    CHECK (period IN ('hour','day')),
  max_count INTEGER NOT NULL DEFAULT 100,
  notify_email VARCHAR(255) NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, channel, period)
);
CREATE INDEX IF NOT EXISTS idx_channel_limits_site_active
  ON channel_limits(site_id, active);

CREATE TABLE IF NOT EXISTS channel_usage (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL,
  period VARCHAR(10) NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  notified BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (site_id, channel, period, period_start)
);
CREATE INDEX IF NOT EXISTS idx_channel_usage_site_channel_period_start
  ON channel_usage(site_id, channel, period, period_start DESC);
