-- Supporto multi-dominio per sito
CREATE TABLE IF NOT EXISTS site_domains (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_domains_domain ON site_domains(domain);

-- Migra il dominio esistente dalla tabella sites
INSERT INTO site_domains (site_id, domain)
SELECT id, domain FROM sites
ON CONFLICT (domain) DO NOTHING;
