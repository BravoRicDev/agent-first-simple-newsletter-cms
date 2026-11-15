-- db/167_oidc_providers.sql
CREATE TABLE IF NOT EXISTS oidc_providers (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  slug VARCHAR(60) NOT NULL,
  name VARCHAR(100) NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT 'openid email profile',
  allowed_email_domains TEXT[] NOT NULL DEFAULT '{}',
  trust_idp_mfa BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_oidc_providers_slug ON oidc_providers (COALESCE(site_id, 0), slug);
