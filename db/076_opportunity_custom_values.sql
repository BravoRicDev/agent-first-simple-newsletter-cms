-- RIFINITURA v1 — storage per valori custom field delle OPPORTUNITÀ.
-- Le opportunità supportano custom field per-tenant (object_key='opportunity',
-- vedi F0/ONDA1_SPEC). La tabella `contact_custom_values` ha un FK su
-- contacts(id), quindi NON può ospitare valori di opportunità: serve una
-- tabella dedicata con FK su opportunities(id). Stesso pattern JSONB
-- `values: { field_key: value }`.
-- Idempotente (IF NOT EXISTS). NESSUNA migrazione dati (struttura pronto-import):
-- la tabella parte vuota.
CREATE TABLE IF NOT EXISTS opportunity_custom_values (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  values JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_custom_values_site
  ON opportunity_custom_values(site_id, opportunity_id);
