-- Feature 38 — Link di pagamento Stripe (CRM nativo).
--
-- Un link pubblico /pay/:token che il cliente apre per pagare. Se è
-- configurata STRIPE_SECRET_KEY il servizio (services/payments.js) crea
-- un Payment Link Stripe reale al momento della creazione e la pagina
-- pubblica reindirizza l'utente su Stripe; senza chiave (ambienti di
-- test/demo) la pagina mostra la modalità simulata "Conferma pagamento".
--
-- opportunity_id è opzionale e punta a opportunities (tabella creata in
-- db/045): un pagamento può essere legato a un affare del CRM.
CREATE TABLE IF NOT EXISTS payment_links (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  contact_email VARCHAR(255) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | active | paid | expired
  stripe_url TEXT NOT NULL DEFAULT '',
  token VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links(token);
CREATE INDEX IF NOT EXISTS idx_payment_links_site_status_created
  ON payment_links(site_id, status, created_at DESC);
