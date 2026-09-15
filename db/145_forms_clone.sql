-- 097: ONDA C - Forms clone API — linkage form_submissions↔forms + contact_id
-- Aggiungi FK form_id (matched by slug) e contact_id (matched by email)
-- a form_submissions. Idempotente: run 2x OK.

ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS form_id INT REFERENCES forms(id) ON DELETE SET NULL;

ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS contact_id INT REFERENCES contacts(id) ON DELETE SET NULL;

-- Backfill form_id: matcha per site_id + slug
UPDATE form_submissions fs
  SET form_id = f.id
  FROM forms f
  WHERE f.site_id = fs.site_id
    AND f.slug = fs.form_slug
    AND fs.form_id IS NULL;

-- Backfill contact_id: matcha per site_id + email LOWER da data JSONB
UPDATE form_submissions fs
  SET contact_id = c.id
  FROM contacts c
  WHERE c.site_id = fs.site_id
    AND LOWER(c.email) = LOWER(fs.data->>'email')
    AND fs.contact_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id ON form_submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_contact_id ON form_submissions(contact_id);
