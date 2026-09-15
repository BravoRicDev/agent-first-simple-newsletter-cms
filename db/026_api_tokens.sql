-- API token di lunga durata per integrazioni non interattive (n8n, altre
-- automazioni) — deliberatamente NON un JWT: un JWT lungo sarebbe revocabile
-- solo con token_version, che disconnetterebbe anche le altre sessioni
-- dell'utente. Qui ogni token è una riga a sé, revocabile singolarmente,
-- con ultimo utilizzo tracciato. Si salva solo l'hash (SHA-256): il valore
-- in chiaro è mostrato una sola volta alla creazione, come i PAT di GitHub.
CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  token_prefix VARCHAR(16) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
