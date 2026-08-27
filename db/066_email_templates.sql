-- Template email per sito (Livello sito): override di soggetto e corpo
-- per ogni tipo di email di sistema. Se non esiste una riga per (site_id,
-- kind), l'email usa il default standard (locales/*.json o testo hardcoded).
-- Placeholder supportati nel subject/body (stessa sintassi {var} dei
-- locales): {siteName}, {siteDomain}, {appName}, {confirmUrl}, {cancelUrl},
-- {when}, {formSlug}, {fieldsHtml}, {title}, {url}, {urlPath}, {date},
-- {pageList}, {note}, {otp}, {link}, {token}, {kind}.
CREATE TABLE IF NOT EXISTS email_templates (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_email_templates_site ON email_templates(site_id);