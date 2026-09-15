-- 092: survey_submissions necessita di created_at/updated_at per il source-sync.
-- upsertByExternalId (src/services/upsert.js) seleziona e aggiorna
-- created_at/updated_at; lo schema sorgente 099_surveys.sql non le includeva,
-- quindi su DB pulito il primo sync falliva con "column created_at does not
-- exist". Le aggiungiamo in modo idempotente.

ALTER TABLE survey_submissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE survey_submissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
