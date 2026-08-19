-- Feature 33 — Riepilogo IA delle chiamate.
-- Dopo una chiamata (prenotata o manuale), l'agente genera un riassunto,
-- una lista di azioni da intraprendere (action_items) e il prossimo passo
-- (next_step). Il riepilogo può essere corretto a mano da un operatore
-- (source='human' resta comunque 'llm' se generato dall'IA: la correzione
-- umana NON cambia la provenienza, la registra solo come done).
-- UNIQUE(site_id, call_id): un solo riepilogo per chiamata.
CREATE TABLE IF NOT EXISTS call_summaries (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  action_items JSONB NOT NULL DEFAULT '[]',
  next_step TEXT DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','done')),
  source VARCHAR(10) NOT NULL DEFAULT 'llm'
    CHECK (source IN ('llm','human','template')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_call_summaries_site_status
  ON call_summaries(site_id, status, updated_at DESC);
