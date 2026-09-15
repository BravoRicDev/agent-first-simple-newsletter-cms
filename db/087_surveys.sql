-- 087: tabelle "surveys" e "survey_submissions" per il mapper source-sync
-- (sondaggi del CRM sorgente). Copiate da db/099_surveys.sql del repo
-- sorgente. Idempotente: CREATE TABLE IF NOT EXISTS + indici IF NOT EXISTS.
--
-- NOTA: le colonne aggiuntive usate dal mapper ("slug"/"questions" su
-- surveys, "survey_slug"/"data" su survey_submissions) sono aggiunte DOPO
-- la creazione delle tabelle, dalla migrazione 089_surveys_source_sync_cols.sql.

CREATE TABLE IF NOT EXISTS surveys (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_external_id
  ON surveys(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surveys_site_id ON surveys(site_id);

CREATE TABLE IF NOT EXISTS survey_submissions (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  answers JSONB NOT NULL DEFAULT '{}',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_submissions_external_id
  ON survey_submissions(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_survey_submissions_survey_id ON survey_submissions(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_submissions_contact_id ON survey_submissions(contact_id);
CREATE INDEX IF NOT EXISTS idx_survey_submissions_site_id ON survey_submissions(site_id);
