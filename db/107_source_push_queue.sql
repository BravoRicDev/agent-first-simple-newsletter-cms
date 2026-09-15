-- 107: Outbox del PUSH verso il CRM sorgente — "fire unico".
--
-- Coda persistente delle mutate del CMS da propagare a sorgente. Ogni riga è
-- un'operazione (upsert/delete) su una risorsa locale (contatto, opportunità).
--
-- In cluster Active/Active il drain segue le stesse regole dell'outbox
-- webhook OUT (105): claim atomico con FOR UPDATE SKIP LOCKED + advisory
-- lock per-sito, così UN SOLO nodo "spara" verso sorgente in ogni finestra.
-- `origin` (cms/source_in/import) serve all'ANTI-ECHO: le mutate originate da
-- sorgente non vengono rispedite a sorgente.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS source_push_queue (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  entity_type VARCHAR(50) NOT NULL,          -- contact | opportunity
  entity_id INT,                             -- id locale della risorsa
  external_id VARCHAR(255) NOT NULL DEFAULT '', -- id sorgente della risorsa (se noto)
  operation VARCHAR(20) NOT NULL DEFAULT 'upsert', -- upsert | delete
  origin VARCHAR(20) NOT NULL DEFAULT 'cms', -- cms | source_in | import
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_source_push_queue_site_status_next
  ON source_push_queue(site_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_source_push_queue_site_entity
  ON source_push_queue(site_id, entity_type, entity_id);