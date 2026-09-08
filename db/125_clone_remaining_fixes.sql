-- 125 — Clone API: lacune di schema trovate SOLO rieseguendo la verifica da
-- uno stato davvero pulito (official-only + db/097-103_clone_*.sql), dopo
-- che la lista iniziale di 4 categorie segnalata dal developer si è
-- rivelata non esaustiva (verificato: con SOLO quel fix la suite
-- clone-parity dava 87 pass/24 fail/28 cancelled su 139, non 139/0).
-- Nessuna di queste tabelle è nella lista ALTER di db/120_ghl_id_columns.sql
-- (tutte le tabelle base — contact_notes, form_submissions, opportunities,
-- social_posts, api_tokens — sono già ufficiali da molto prima di 120;
-- solo mancavano alcune colonne/tabelle satellite), quindi nessun vincolo
-- di ordinamento: può stare dopo 124.

-- ── 1. Commerce (Onda H): coupons ────────────────────────────────────────
-- products/product_prices/invoices/invoice_items sono già ufficiali
-- (db/088_commerce_campaigns.sql, copia verbatim dello stesso file di
-- lavoro) — solo coupons mancava.
CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  discount_type VARCHAR(10) NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC(12,2) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_external_id
  ON coupons(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_site_code
  ON coupons(site_id, code);

-- ── 2. Contacts (Onda A): note/task per la clone API ─────────────────────
ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS contact_id INT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'fk_contact_notes_contact'
                 AND table_name = 'contact_notes') THEN
    ALTER TABLE contact_notes
      ADD CONSTRAINT fk_contact_notes_contact
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact_id
  ON contact_notes(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS user_id INT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'fk_contact_notes_user'
                 AND table_name = 'contact_notes') THEN
    ALTER TABLE contact_notes
      ADD CONSTRAINT fk_contact_notes_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_contact_notes_user_id
  ON contact_notes(user_id) WHERE user_id IS NOT NULL;

ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS external_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_notes_external_id
  ON contact_notes(external_id) WHERE external_id IS NOT NULL;

-- Backfill contact_id dalla corrispondenza (site_id, contact_email) per le
-- righe esistenti (in un deploy con dati reali; no-op su DB vuoto).
UPDATE contact_notes cn
  SET contact_id = c.id
  FROM contacts c
  WHERE cn.site_id = c.site_id
    AND cn.contact_email = c.email
    AND cn.contact_id IS NULL;

UPDATE contact_notes SET external_id = gen_random_uuid()
  WHERE external_id IS NULL;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_date TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_date
  ON tasks(reminder_date) WHERE reminder_date IS NOT NULL;

-- ── 3. Forms (Onda C): linkage submission↔form/contact ───────────────────
ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS form_id INT REFERENCES forms(id) ON DELETE SET NULL;
ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS contact_id INT REFERENCES contacts(id) ON DELETE SET NULL;

UPDATE form_submissions fs
  SET form_id = f.id
  FROM forms f
  WHERE f.site_id = fs.site_id
    AND f.slug = fs.form_slug
    AND fs.form_id IS NULL;

UPDATE form_submissions fs
  SET contact_id = c.id
  FROM contacts c
  WHERE c.site_id = fs.site_id
    AND LOWER(c.email) = LOWER(fs.data->>'email')
    AND fs.contact_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id ON form_submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_contact_id ON form_submissions(contact_id);

-- ── 4. OAuth provider (Onda G2): scope sui token agente ──────────────────
-- Usato da /oauth/authorize/decision per validare il token dell'utente che
-- approva/nega — non un requisito satellite-specifico nonostante il nome
-- storico del file di origine (api_token_scopes).
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['read', 'write']::text[];
COMMENT ON COLUMN api_tokens.scopes IS 'Scope del token ("read", "write"). Default legacy = entrambi; token nuovi = sola lettura, scrittura opt-in.';

-- ── 5. Opportunities (Onda A): campi extra + followers ───────────────────
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS source VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_status_change TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lost_reason TEXT;

CREATE TABLE IF NOT EXISTS opportunity_followers (
  id SERIAL PRIMARY KEY,
  external_id UUID NOT NULL DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_opportunity_follower UNIQUE(opportunity_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_followers_opportunity
  ON opportunity_followers(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_followers_site
  ON opportunity_followers(site_id);

-- ── 6. Social (Onda H3): tenancy esplicita + piattaforme clone ───────────
-- social_posts (db/015_social_posts.sql) è scope via page_id (nullable),
-- il clone API richiede site_id esplicito. I post legacy (site_id NULL)
-- restano invisibili alle API clone.
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS site_id INT REFERENCES sites(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_social_posts_site ON social_posts(site_id);

-- Il CHECK legacy su platform copriva solo twitter/linkedin/facebook.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'social_posts_platform_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%instagram%'
  ) THEN
    ALTER TABLE social_posts DROP CONSTRAINT social_posts_platform_check;
    ALTER TABLE social_posts ADD CONSTRAINT social_posts_platform_check
      CHECK (platform IN ('twitter','linkedin','facebook','instagram','gmb','tiktok'));
  END IF;
END
$$;

-- ── 7. Surveys (Onda D): domande normalizzate ────────────────────────────
-- La tabella surveys ufficiale ha già slug/questions (JSONB, modello
-- flattened) MA src/services/surveys-clone.js interroga una tabella
-- separata survey_questions (modello normalizzato, con position/show_if) —
-- i due modelli convivono, la clone API usa quello normalizzato.
CREATE TABLE IF NOT EXISTS survey_questions (
  id SERIAL PRIMARY KEY,
  external_id UUID DEFAULT gen_random_uuid(),
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  type VARCHAR(20) NOT NULL DEFAULT 'TEXT' CHECK (type IN ('TEXT', 'TEXTAREA', 'DROPDOWN', 'RADIO', 'CHECKBOX', 'DATE', 'NUMERIC')),
  label VARCHAR(500) NOT NULL,
  required BOOLEAN NOT NULL DEFAULT false,
  options JSONB NOT NULL DEFAULT '[]',
  show_if JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_survey_questions_survey_id ON survey_questions(survey_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_questions_external_id
  ON survey_questions(external_id) WHERE external_id IS NOT NULL;

-- ── 8. Webhook OUT (Onda I): formato selezionabile per webhook ──────────
-- Richiesta da src/services/webhooks.js (fix di questa stessa sessione,
-- vedi RIEPILOGO_COMPLETO_modifiche_2026-09-08.txt parte B.7): 'legacy'
-- (default, {event_type,payload}) oppure 'target' (flat
-- {type,eventId,eventName,locationId,<resource>...}).
ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS payload_format VARCHAR(10)
    NOT NULL DEFAULT 'legacy'
    CHECK (payload_format IN ('legacy', 'target'));
