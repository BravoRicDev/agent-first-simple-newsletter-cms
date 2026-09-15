-- 103: external_id mancante su survey_questions — la shape clone espone
-- l'id uuid della domanda (serve anche a show_if), quindi serve la colonna.
-- Fix da verifica centrale onda D (migrazione 099 non la includeva).
ALTER TABLE survey_questions ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_questions_external_id
  ON survey_questions(external_id)
  WHERE external_id IS NOT NULL;
