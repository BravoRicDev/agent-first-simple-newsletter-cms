-- Migrazione idempotente: aggiorna contact_notes per la clone API.
-- Aggiunge contact_id (FK), user_id (FK), updated_at, external_id.
-- Backfill contact_id da join con contacts su (site_id, contact_email).
-- Backfill user_id remains NULL (risolto da caller tramite external_id).

-- contact_id: FK a contacts(id), indice per query veloci.
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

-- user_id: FK a users(id), null finché non assegnato, indice per query.
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

-- updated_at: per il contratto API (null fino a primo aggiornamento).
ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- external_id UUID per clone API.
ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS external_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_notes_external_id
  ON contact_notes(external_id) WHERE external_id IS NOT NULL;

-- Backfill contact_id dalla corrispondenza (site_id, contact_email).
-- Solo righe dove contact_id IS NULL e una corrispondenza esiste.
UPDATE contact_notes cn
  SET contact_id = c.id
  FROM contacts c
  WHERE cn.site_id = c.site_id
    AND cn.contact_email = c.email
    AND cn.contact_id IS NULL;

-- Backfill external_id dove assente (lazy generation).
UPDATE contact_notes SET external_id = gen_random_uuid()
  WHERE external_id IS NULL;

-- Aggiungi colonna reminder_date sulla tabella tasks.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_date TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_date
  ON tasks(reminder_date) WHERE reminder_date IS NOT NULL;
