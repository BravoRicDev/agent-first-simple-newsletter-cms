-- Feature 40 — Dashboard realtime CRM: viste salvabili (layout/widget).
-- I KPI non vengono materializzati qui: sono calcolati live dal servizio
-- src/services/dashboard.js. Questa tabella salva solo la configurazione
-- delle viste (nome + widget) per utente/sito.
CREATE TABLE IF NOT EXISTS dashboard_views (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  config JSONB NOT NULL DEFAULT '{"widgets":[]}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_views_site ON dashboard_views(site_id);
