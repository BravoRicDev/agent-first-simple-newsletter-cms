-- Feature 35 — Webhook IN/OUT per collegare n8n e automazioni esterne.
--
-- IN: endpoint pubblico POST /webhooks/in/:siteId/:token; il token (secret)
-- identifica il webhook; il mapping `events` associa event_type esterni
-- (es. "lead.created") ad azioni interne (create_contact, emit_event,
-- add_tag, create_task).
-- OUT: ad ogni evento CMS (emitContactEvent) viene accodata una delivery
-- verso l'URL esterno; `secret` firma il body con HMAC-SHA256
-- (header X-Webhook-Signature); `events` è la lista di event_type da
-- inoltrare. Le delivery fallite ritentano con backoff esponenziale
-- (2^attempts minuti, max 5 tentativi) tramite deliverPending().
CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'out'
    CHECK (direction IN ('in','out')),
  url TEXT NOT NULL DEFAULT '',
  secret VARCHAR(255) NOT NULL DEFAULT '',
  events JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_site_direction_active
  ON webhooks(site_id, direction, active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_site_status_next
  ON webhook_deliveries(site_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_status_next
  ON webhook_deliveries(webhook_id, status, next_attempt_at);
