-- 117: Security features for Webhook IN (inbound)
-- allowed_ips: JSONB array di CIDR o IP singoli (es. ["1.2.3.4", "192.168.1.0/24"]).
-- verify_secret: chiave segreta per verifica HMAC-SHA256 del body (header X-Webhook-Signature).
-- Entrambi opzionali; se vuoti, le protezioni non si applicano.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS allowed_ips JSONB NOT NULL DEFAULT '[]';
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS verify_secret VARCHAR(255) NOT NULL DEFAULT '';

-- Log inbound webhook attempts (accepted/filtered/blocked/signature_fail).
-- Permette UI/agent di diagnosticare perché un webhook non ha fatto fuoco.
CREATE TABLE IF NOT EXISTS webhook_inbound_log (
  id BIGSERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  webhook_id INTEGER REFERENCES webhooks(id) ON DELETE SET NULL,
  direction VARCHAR(3) NOT NULL DEFAULT 'in',
  event_type VARCHAR(100),
  ip INET,
  status VARCHAR(20) NOT NULL, -- 'accepted', 'filtered', 'ip_blocked', 'signature_fail', 'invalid_token', 'error'
  reason TEXT,
  request_body JSONB,
  response_status INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_inbound_log_site_created
  ON webhook_inbound_log(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_inbound_log_webhook_status
  ON webhook_inbound_log(webhook_id, status, created_at DESC);