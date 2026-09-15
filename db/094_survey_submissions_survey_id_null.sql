-- 094: survey_submissions.survey_id deve ammettere NULL. Il mapper surveys
-- del source-sync collega le submission alla survey tramite "survey_slug"
-- (non via FK survey_id), quindi non popola survey_id: con il NOT NULL dello
-- schema 099_surveys.sql il primo sync falliva con "null value in column
-- survey_id". Rilassiamo il vincolo (la FK resta, solo NULL-amissibile).
-- Idempotente.

ALTER TABLE survey_submissions ALTER COLUMN survey_id DROP NOT NULL;
