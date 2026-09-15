-- Feature 36 — OAuth Google (flusso Authorization Code per Gmail/Calendar/Drive).
--
-- oauth_apps: credenziali OAuth (client_id, client_secret, redirect_uri,
-- scopes) configurate per sito. Senza credenziali configurate il servizio
-- fallisce in modo pulito ({error}, mai crash).
-- oauth_connections: token ottenuti dopo il consenso dell'utente
-- (access_token, refresh_token, scadenza, account email).
-- Il file è idempotente (IF NOT EXISTS): può girare a vuoto più volte.
CREATE TABLE IF NOT EXISTS oauth_apps (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL DEFAULT 'google',
  client_id VARCHAR(255) NOT NULL DEFAULT '',
  client_secret VARCHAR(255) NOT NULL DEFAULT '',
  redirect_uri VARCHAR(500) NOT NULL DEFAULT '',
  scopes JSONB NOT NULL DEFAULT '["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/calendar"]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oauth_apps_site_provider
  ON oauth_apps(site_id, provider);

CREATE TABLE IF NOT EXISTS oauth_connections (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  app_id INTEGER REFERENCES oauth_apps(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL DEFAULT 'google',
  account_email VARCHAR(255) NOT NULL DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  token_expires_at TIMESTAMPTZ,
  scope JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_site_app
  ON oauth_connections(site_id, app_id);
