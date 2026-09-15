-- Feature 34 — Proposta di risposta all'operatore.
-- L'agente AI (o un template deterministico) prepara una bozza di risposta
-- partendo dalla conversazione del lead e dagli articoli della knowledge
-- base; l'operatore la approva con un clic (status used) o la scarta
-- (status dismissed). source dice come è stata generata la bozza:
--   'llm'      → completamento LLM (config.llmApiKey)
--   'kb'       → template deterministico costruito su articoli KB trovati
--   'template' → template generico senza articoli KB
-- kb_article_ids: id degli articoli KB usati come riferimento.
-- Nessuna FK verso conversations: la conversazione può essere eliminata
-- senza bloccare la cancellazione (le righe restano come storico).
CREATE TABLE IF NOT EXISTS reply_suggestions (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL,
  contact_email VARCHAR(255) NOT NULL DEFAULT '',
  suggested_text TEXT NOT NULL DEFAULT '',
  source VARCHAR(10) NOT NULL DEFAULT 'template'
    CHECK (source IN ('llm','template','kb')),
  kb_article_ids JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','used','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reply_suggestions_site_status_created
  ON reply_suggestions(site_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_suggestions_conversation
  ON reply_suggestions(conversation_id, created_at DESC);
