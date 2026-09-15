-- Opportunità/affari + preventivi PDF.
-- Un'affare è legato a un contatto e a una pipeline (stadi custom da
-- db/043); porta importo e probabilità. I preventivi sono documenti
-- con stato inviato/visto/firmato e un token pubblico per il link al
-- cliente (pattern pref_token).
CREATE TABLE IF NOT EXISTS opportunities (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  contact_email VARCHAR(255) NOT NULL,
  pipeline_id INTEGER REFERENCES pipelines(id) ON DELETE SET NULL,
  stage VARCHAR(100) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  status VARCHAR(20) NOT NULL DEFAULT 'open',  -- open | won | lost
  expected_close_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_opportunities_site
  ON opportunities(site_id, status, updated_at DESC);

-- Preventivi: righe in items JSONB [{description, qty, price}], stato
-- draft → sent → viewed → signed, token pubblico per il link al cliente.
CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  contact_email VARCHAR(255) NOT NULL,
  quote_number VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | sent | viewed | signed
  token VARCHAR(64) NOT NULL,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_token ON quotes(token);
CREATE INDEX IF NOT EXISTS idx_quotes_site ON quotes(site_id, status, created_at DESC);

-- Numerazione progressiva preventivi (globale, leggibile: Q-000123).
CREATE SEQUENCE IF NOT EXISTS quotes_number_seq START 1;
