-- SMTP dedicato per sito. Tabella separata da site_variables perché
-- site_variables viene espansa con {{var:key}} dentro il contenuto
-- pubblico delle pagine (src/services/page-renderer.js) — non è un posto
-- sicuro per credenziali.
CREATE TABLE IF NOT EXISTS newsletter_settings (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  smtp_host VARCHAR(255) NOT NULL DEFAULT '',
  smtp_port INTEGER NOT NULL DEFAULT 465,
  smtp_user VARCHAR(255) NOT NULL DEFAULT '',
  smtp_pass VARCHAR(255) NOT NULL DEFAULT '',
  from_email VARCHAR(255) NOT NULL DEFAULT '',
  rate_per_hour INTEGER NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  token VARCHAR(64) NOT NULL UNIQUE,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  UNIQUE(site_id, email)
);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_site_status ON newsletter_subscribers(site_id, status);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_token ON newsletter_subscribers(token);

CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subject VARCHAR(500) NOT NULL,
  html_content TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_newsletter_campaigns_site_status ON newsletter_campaigns(site_id, status);

CREATE TABLE IF NOT EXISTS newsletter_sends (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  open_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(campaign_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_campaign ON newsletter_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_sent_at ON newsletter_sends(sent_at);
