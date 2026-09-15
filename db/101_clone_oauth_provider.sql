-- 101 — Clone API: OAuth provider per app terze — authorization code flow,
-- token management. Recuperata da file di lavoro mai committati (vedi nota
-- in 097_clone_sites_columns.sql). Idempotente: esecuzioni multiple OK.

CREATE TABLE IF NOT EXISTS oauth_provider_apps (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid() UNIQUE,
  site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  client_id VARCHAR(64) NOT NULL UNIQUE,
  client_secret_hash VARCHAR(128) NOT NULL,
  name VARCHAR(255) NOT NULL,
  redirect_uris JSONB NOT NULL DEFAULT '[]',
  scopes JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_provider_codes (
  id SERIAL PRIMARY KEY,
  code_hash VARCHAR(128) NOT NULL,
  app_id INT NOT NULL REFERENCES oauth_provider_apps(id) ON DELETE CASCADE,
  site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri VARCHAR(500) NOT NULL,
  scope VARCHAR(500) NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_provider_tokens (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid() UNIQUE,
  app_id INT NOT NULL REFERENCES oauth_provider_apps(id) ON DELETE CASCADE,
  site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash VARCHAR(128) NOT NULL UNIQUE,
  refresh_hash VARCHAR(128) NOT NULL UNIQUE,
  scope VARCHAR(500) NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_apps_site_id ON oauth_provider_apps(site_id);
CREATE INDEX IF NOT EXISTS idx_oauth_apps_client_id ON oauth_provider_apps(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_app_id ON oauth_provider_codes(app_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_code_hash ON oauth_provider_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_app_id ON oauth_provider_tokens(app_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_hash ON oauth_provider_tokens(access_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_hash ON oauth_provider_tokens(refresh_hash);
