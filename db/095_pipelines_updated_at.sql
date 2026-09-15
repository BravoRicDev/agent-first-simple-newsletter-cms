-- 095: la tabella "pipelines" mancava della colonna updated_at. upsertByExternalId
-- (src/services/upsert.js) seleziona e aggiorna created_at/updated_at su tutte
-- le tabelle del source-sync, quindi il mapper "pipelines" (e qualsiasi altro
-- mapper che scrive su pipelines) falliva con "column updated_at does not exist".
-- Aggiungiamo la colonna in modo idempotente.
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
