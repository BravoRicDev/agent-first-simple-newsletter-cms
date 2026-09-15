-- Coda eventi tra satelliti (F2): mini-broker nel CMS, nessun broker esterno.
-- Un satellite pubblica (POST /api/agent/events), i destinatari leggono SOLO
-- i propri eventi (target = proprio nome o '*') via GET /inbox e confermano
-- con POST /:id/ack. Idempotenza via dedupe_key per (source, dedupe_key).
--
-- Il webhook push (delivery con retry/backoff) e' differito: le colonne
-- attempts/last_error/delivered_at sono gia pronte per quando servira.

CREATE TABLE IF NOT EXISTS satellite_events (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT NOT NULL,                -- es 'opportunity_won', 'escalation.triggered'
  source       TEXT NOT NULL,                -- satellite che pubblica
  target       TEXT NOT NULL DEFAULT '*',    -- satellite destinatario o '*'
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   TEXT,                         -- idempotenza lato publisher
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','delivered','acked','failed')),
  attempts     INT  NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  acked_at     TIMESTAMPTZ
);

-- Idempotenza: stessa coppia (source, dedupe_key) = un solo evento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_satellite_events_dedupe
  ON satellite_events (source, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Inbox per-target: polling del ricevente (target proprio o broadcast).
CREATE INDEX IF NOT EXISTS idx_satellite_events_inbox
  ON satellite_events (target, status, created_at);
