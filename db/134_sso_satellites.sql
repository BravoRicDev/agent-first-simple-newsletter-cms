-- Registro moduli satellite per SSO e allowlist redirect_uri (idempotente).
-- Ogni modulo satellite (sottodominio con login condiviso del CMS, es.
-- sales.esempio.com) e' un record in questa tabella. Solo gli origin qui
-- registrati (enabled = true) possono ricevere il redirect_uri post-login:
-- previene open-redirect nel flusso /login -> magic-link -> verify.
--
-- L'onboarding di un nuovo satellite NON richiede migrazioni: basta INSERT
-- via admin UI (/admin/satellites), agent API o MCP tool.

CREATE TABLE IF NOT EXISTS sso_satellites (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  origin      VARCHAR(255) NOT NULL UNIQUE,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sso_satellites_origin ON sso_satellites(origin);

COMMENT ON TABLE sso_satellites IS 'Moduli satellite (sottodomini) che usano SSO con il CMS. Solo gli origin registrati ed enabled possono ricevere il redirect_uri post-login.';

-- Nessun seed: la registrazione dei satelliti avviene a runtime via admin UI
-- (/admin/satellites), agent API o MCP tool — non tramite dati fissi qui.
