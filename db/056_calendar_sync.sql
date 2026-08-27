-- Feature 37 — Sync calendario bidirezionale (chiamate ↔ Google Calendar).
--
-- Una config per sito collega un calendario Google (tramite la connessione
-- OAuth della feature 36, tabella oauth_connections) alle chiamate della
-- tabella calls:
--   direction 'out'  → le calls programmate vengono create come eventi Google
--   direction 'in'   → gli eventi Google "Chiamata con <email>" diventano calls
--   direction 'both' → entrambe le direzioni a ogni syncNow()
-- `mapping` (JSONB) personalizza il comportamento: es.
--   {"call_status_to_event": "busy", "event_to_call_status": "programmata"}.
-- `calendar_sync_log` registra ogni esecuzione (direzione, verso push/pull,
-- numero di elementi, status) così l'agente può verificare l'esito.
CREATE TABLE IF NOT EXISTS calendar_sync_configs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- NOTA: nessuna FK verso oauth_connections: quella tabella arriva con la
  -- feature 36 (migrazione 055) e potrebbe non esistere ancora quando questa
  -- migrazione viene applicata. Il riferimento è verificato a runtime da
  -- src/services/calendar-sync.js. Se 055 arriva prima, si può aggiungere la
  -- FK (ON DELETE SET NULL) a posteriori senza impatto funzionale.
  oauth_connection_id INTEGER,
  calendar_id VARCHAR(255) NOT NULL DEFAULT 'primary',
  direction VARCHAR(10) NOT NULL DEFAULT 'both'
    CHECK (direction IN ('both','in','out')),
  mapping JSONB NOT NULL DEFAULT '{}',
  last_sync_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_configs_site_active
  ON calendar_sync_configs(site_id, active);

CREATE TABLE IF NOT EXISTS calendar_sync_log (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  config_id INTEGER REFERENCES calendar_sync_configs(id) ON DELETE CASCADE,
  direction VARCHAR(10),
  kind VARCHAR(10) CHECK (kind IN ('push','pull')),
  count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok','error')),
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_log_config_created
  ON calendar_sync_log(config_id, created_at DESC);
