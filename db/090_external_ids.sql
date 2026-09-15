-- 090: Identificatori esterni (UUID) per-risorsa per il source-sync.
-- Portato da db/090_external_ids.sql del repo sorgente. Nel target mancava
-- del tutto: il source-sync (upsertByExternalId / ensureExternalId in
-- src/services/external-ids.js) richiede la colonna "external_id" su tutte
-- le tabelle in WHITELIST_TABLES, altrimenti il primo sync su un DB pulito
-- fallisce con "column external_id does not exist".
--
-- Colonna nullable + indice univoco parziale (WHERE NOT NULL): le righe
-- esistenti restano NULL finché non richieste via API (assegnazione lazy),
-- i nuovi insert ricevono subito un UUID. Idempotente: ADD COLUMN IF NOT
-- EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS (no-op in reinstallazioni).
-- gen_random_uuid() è nativo da PostgreSQL 13, nessuna extension richiesta.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_external_id ON contacts(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_notes_external_id ON contact_notes(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_id ON tasks(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_external_id ON opportunities(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_external_id ON pipelines(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_external_id ON pipeline_stages(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_fields_external_id ON custom_fields(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_external_id ON workflows(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE segments ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_external_id ON segments(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE forms ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_external_id ON forms(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_submissions_external_id ON form_submissions(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_quizzes_external_id ON quizzes(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_submissions_external_id ON quiz_submissions(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_external_id ON quotes(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_external_id ON payment_links(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_external_id ON conversations(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_external_id ON conversation_messages(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_campaigns_external_id ON newsletter_campaigns(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE newsletter_sequences ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_sequences_external_id ON newsletter_sequences(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_external_id ON newsletter_subscribers(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE tracked_links ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_links_external_id ON tracked_links(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id ON users(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_external_id ON webhooks(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE booking_appointments ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_appointments_external_id ON booking_appointments(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE calendars ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_external_id ON calendars(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_external_id ON email_templates(external_id) WHERE external_id IS NOT NULL;

-- sites: nel sorgente gestito in db/095_sites_external_uuid.sql; nel target
-- mancava del tutto, necessario per gli use-case di clone API.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_external_id ON sites(external_id) WHERE external_id IS NOT NULL;

-- social_posts: nel sorgente gestito in db/106_social_memberships.sql.
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_external_id ON social_posts(external_id) WHERE external_id IS NOT NULL;
