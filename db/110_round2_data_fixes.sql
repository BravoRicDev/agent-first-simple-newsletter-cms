-- 110: Round-2 bug-fix su dati e cluster.
--
-- 1. conversation_messages: colonna source_message_id (id del messaggio sul
--    CRM sorgente) + indice UNIQUE parziale → il mapper conversazioni usa
--    ON CONFLICT DO NOTHING e a ogni sync ri-importa i messaggi senza
--    DUPLICARLI (prima l'INSERT era senza vincolo: l'intera cronologia
--    veniva reinserita a ogni full sync).
--
-- 2. source_push_queue: l'indice anti-duplicato viene esteso con `operation`.
--    Il dedup di enqueuePush deve distinguere upsert/delete: altrimenti una
--    delete su un'entità con un upsert ancora pending veniva scartata (bug
--    "delete persa"). Con operation nell'indice, upsert e delete dello stesso
--    entità possono coesistere e vengono processati in ordine di coda.
--
-- Idempotente.

ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS source_message_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_source_id
  ON conversation_messages(source_message_id)
  WHERE source_message_id IS NOT NULL;

DROP INDEX IF EXISTS idx_source_push_queue_pending_entity;
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_push_queue_pending_entity
  ON source_push_queue(site_id, entity_type, entity_id, operation)
  WHERE status IN ('pending', 'sending');