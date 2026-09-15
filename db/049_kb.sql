-- Feature 30 — Knowledge base aziendale (listini, FAQ, procedure).
-- Articoli liberi per sito, con categoria e tag, e ricerca full-text
-- italiana su titolo + contenuto (indice GIN sull'espressione tsvector).
CREATE TABLE IF NOT EXISTS kb_articles (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Filtro per sito + categoria (listini / faq / procedure / ...).
CREATE INDEX IF NOT EXISTS idx_kb_articles_site_category
  ON kb_articles(site_id, category);

-- Full-text italiano: titolo + contenuto in un unico tsvector indicizzato.
CREATE INDEX IF NOT EXISTS idx_kb_articles_search
  ON kb_articles
  USING GIN (to_tsvector('italian', coalesce(title,'') || ' ' || coalesce(content,'')));
