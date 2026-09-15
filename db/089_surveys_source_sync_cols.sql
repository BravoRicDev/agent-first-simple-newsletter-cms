-- 089: colonne usate dal mapper "surveys" di source-sync. Le tabelle
-- surveys e survey_submissions sono create da 087_surveys.sql; qui si
-- aggiungono (DOPO la creazione) le colonne che il mapper scrive:
-- surveys(slug, questions) e survey_submissions(survey_slug, data).
-- Idempotente: ADD COLUMN IF NOT EXISTS (no-op sulle installazioni in cui
-- le colonne esistono gia').

ALTER TABLE surveys ADD COLUMN IF NOT EXISTS slug VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS questions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE survey_submissions ADD COLUMN IF NOT EXISTS survey_slug VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE survey_submissions ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;
