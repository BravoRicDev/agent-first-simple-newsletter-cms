-- F0 — Fondamenta: substrato multi-tenant API-compatibile.
-- Tabelle nuove (tutte idempotenti: CREATE ... IF NOT EXISTS / ON CONFLICT):
--   custom_fields    — campi custom per-tenant con chiave (id) stabile.
--   pipeline_stages  — stadi di pipeline con chiave stabile (id stabile).
--   tenant_config    — config per-tenant generalizzata (credenziali esterne).
--   site_api_keys    — API key per-sito (Bearer), solo hash SHA-256 salvato.
--   capabilities     — registry capability del substrato agent-first (seed base).

CREATE TABLE IF NOT EXISTS custom_fields (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  object_key VARCHAR(100) NOT NULL,
  field_key VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  type VARCHAR(30) NOT NULL DEFAULT 'text',
  options JSONB NOT NULL DEFAULT '[]',
  is_public BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, object_key, field_key)
);
CREATE INDEX IF NOT EXISTS idx_custom_fields_site ON custom_fields(site_id, object_key);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id SERIAL PRIMARY KEY,
  pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL DEFAULT '',
  color VARCHAR(30) NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pipeline_id, key)
);

CREATE TABLE IF NOT EXISTS tenant_config (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, key)
);

CREATE TABLE IF NOT EXISTS site_api_keys (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  token_prefix VARCHAR(16) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, name)
);

CREATE TABLE IF NOT EXISTS capabilities (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);

-- Seed base capability registry (substrato agent-first). Fire-and-forget:
-- ON CONFLICT DO NOTHING garantisce idempotenza anche su riesecuzione.
INSERT INTO capabilities (key, name, description) VALUES
  ('contacts.read',       'Lettura contatti',          'Leggere i contatti del tenant'),
  ('contacts.write',      'Scrittura contatti',        'Creare/aggiornare/cancellare contatti'),
  ('opportunities.read',  'Lettura opportunità',       'Leggere le opportunità del tenant'),
  ('opportunities.write', 'Scrittura opportunità',     'Creare/aggiornare/cancellare opportunità'),
  ('custom-fields.read',  'Lettura campi custom',      'Leggere la definizione dei campi custom'),
  ('custom-fields.write', 'Scrittura campi custom',    'Creare/aggiornare/cancellare campi custom'),
  ('config.read',         'Lettura configurazione',    'Leggere la config del tenant'),
  ('config.write',        'Scrittura configurazione',  'Aggiornare la config del tenant'),
  ('webhooks.out',        'Emissione webhook out',     'Emettere eventi verso destinazioni esterne'),
  ('agent.*',             'Accesso agente',            'Operazioni del substrato agente (capability jolly)')
ON CONFLICT (key) DO NOTHING;
