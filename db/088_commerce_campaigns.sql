-- 088: tabelle per il source-sync dei domini "commerce" e "campaigns".
-- Schema copiato dal repo sorgente:
--   - commerce: db/104_commerce.sql  (products, product_prices, invoices,
--     invoice_items)
--   - campaigns: db/098_campaigns_clone.sql  (campaign_subscriptions,
--     marketing_templates)
-- Idempotente: CREATE TABLE IF NOT EXISTS + indici IF NOT EXISTS.

-- ── Commerce ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  product_type VARCHAR(20) NOT NULL DEFAULT 'physical' CHECK (product_type IN ('physical', 'digital', 'service')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_external_id
  ON products(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_site_id ON products(site_id);

CREATE TABLE IF NOT EXISTS product_prices (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL DEFAULT 'Standard',
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  billing_type VARCHAR(20) NOT NULL DEFAULT 'one_time' CHECK (billing_type IN ('one_time', 'recurring')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_prices_external_id
  ON product_prices(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_prices_product_id ON product_prices(product_id);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  invoice_number VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  issue_date DATE NULL,
  due_date DATE NULL,
  paid_at TIMESTAMPTZ NULL,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  stripe_payment_link TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_external_id
  ON invoices(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number
  ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_site_id ON invoices(site_id);
CREATE INDEX IF NOT EXISTS idx_invoices_contact_id ON invoices(contact_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_items_external_id
  ON invoice_items(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);

-- ── Campaigns / Marketing ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_subscriptions (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_campaign_subscription UNIQUE(campaign_id, contact_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_subscriptions_external_id
  ON campaign_subscriptions(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing_templates (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL DEFAULT 'EMAIL',
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  body_html TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_templates_external_id
  ON marketing_templates(external_id) WHERE external_id IS NOT NULL;
