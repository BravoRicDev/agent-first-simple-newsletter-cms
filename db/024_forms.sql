-- Definizioni dei form (form builder). Separata da form_submissions perché
-- un form può ricevere invii anche senza mai essere definito qui (form
-- scritti a mano in HTML dentro una pagina, workflow preesistente) — questa
-- tabella è opzionale: form_submissions.form_slug resta un testo libero, non
-- una FK, per non rompere nulla di già in produzione.
CREATE TABLE IF NOT EXISTS forms (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  submit_label VARCHAR(100) NOT NULL DEFAULT 'Invia',
  success_message TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);
