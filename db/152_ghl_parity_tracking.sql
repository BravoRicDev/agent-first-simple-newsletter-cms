-- Tracciamento parità clone/GHL ("shadow comparison"): per ogni endpoint di
-- lettura del clone, confrontiamo in background il payload che serviamo con
-- una chiamata IDENTICA fatta dal vivo a GHL reale. Dopo 100 confronti
-- consecutivi identici (per sito + endpoint) smettiamo di interrogare GHL
-- per quella coppia — il clone è considerato fedele al 100% lì.
-- Un solo confronto diverso azzera il contatore e fa ripartire la
-- verifica dal vivo.
--
-- Budget SEPARATO da quello del sync periodico reale (source_sync_config.
-- daily_quota/budget_percent/calls_count): le chiamate di shadow-verifica
-- non devono MAI competere per la stessa quota con il sync vero, che ha
-- priorità.

ALTER TABLE source_sync_config ADD COLUMN IF NOT EXISTS shadow_daily_quota INTEGER NOT NULL DEFAULT 200;
ALTER TABLE source_sync_config ADD COLUMN IF NOT EXISTS shadow_calls_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_sync_config ADD COLUMN IF NOT EXISTS shadow_calls_date DATE;

-- Stato corrente della verifica per (sito, endpoint): quante volte di fila
-- il payload è risultato identico, e da quando (se) siamo passati in
-- passthrough puro (niente più chiamate GHL per questa coppia).
CREATE TABLE IF NOT EXISTS ghl_parity_state (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  endpoint VARCHAR(200) NOT NULL,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  passthrough_since TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, endpoint)
);

-- Log di ogni confronto (o tentativo saltato). request_key identifica la
-- richiesta concreta (es. un contact source_id) solo per debug — non è
-- parte della chiave di stato, che resta per (site_id, endpoint).
CREATE TABLE IF NOT EXISTS ghl_parity_log (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  endpoint VARCHAR(200) NOT NULL,
  request_key VARCHAR(500) NOT NULL DEFAULT '',
  clone_payload JSONB NOT NULL,
  ghl_payload JSONB,
  match BOOLEAN,
  skip_reason VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ghl_parity_log_site_endpoint ON ghl_parity_log(site_id, endpoint, created_at DESC);
-- Retention: il log serve per debug a breve termine, non come storico permanente.
-- Nessuna pulizia automatica in questa migrazione (da valutare se il volume cresce).
