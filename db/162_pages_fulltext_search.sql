-- db/162_pages_fulltext_search.sql
-- Indice di ricerca in una TABELLA SEPARATA (non una colonna di pages): SELECT * / RETURNING * / backup di pages restano identici.
CREATE TABLE IF NOT EXISTS page_search_index (
  page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL,
  tsv tsvector NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_search_index_tsv ON page_search_index USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_page_search_index_site ON page_search_index (site_id);
-- Testo semplice: script/style rimossi con due regex SENZA backreference (la versione con \1 era quadratica: 8,6 s su 14000 <script> e rimuoveva anche il testo tra script diversi).
CREATE OR REPLACE FUNCTION pages_plain_text(p_content text) RETURNS text AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(left(coalesce(p_content, ''), 300000),
    '<script[^>]*?>.*?</script>', ' ', 'gi'), '<style[^>]*?>.*?</style>', ' ', 'gi'), '<[^>]+>', ' ', 'g')
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION pages_build_tsv(p_site_id integer, p_title text, p_excerpt text, p_content text) RETURNS tsvector AS $$
DECLARE cfg text;
BEGIN
  SELECT value INTO cfg FROM settings WHERE site_id = p_site_id AND key = 'search_language' LIMIT 1;
  IF cfg IS NULL OR cfg NOT IN ('italian','english','simple') THEN cfg := 'italian'; END IF;
  RETURN setweight(to_tsvector(cfg::regconfig, coalesce(p_title, '')), 'A')
      || setweight(to_tsvector(cfg::regconfig, left(coalesce(p_excerpt, ''), 5000)), 'B')
      || setweight(to_tsvector(cfg::regconfig, pages_plain_text(p_content)), 'C');
EXCEPTION WHEN OTHERS THEN
  RETURN to_tsvector('simple', left(coalesce(p_title, ''), 500));   -- l'indicizzazione NON deve mai bloccare il salvataggio di una pagina
END $$ LANGUAGE plpgsql STABLE;
CREATE OR REPLACE FUNCTION pages_search_index_sync() RETURNS trigger AS $$
BEGIN
  INSERT INTO page_search_index (page_id, site_id, tsv)
  VALUES (NEW.id, NEW.site_id, pages_build_tsv(NEW.site_id, NEW.title, NEW.excerpt, NEW.content))
  ON CONFLICT (page_id) DO UPDATE SET site_id = EXCLUDED.site_id, tsv = EXCLUDED.tsv;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pages_search_index ON pages;
CREATE TRIGGER trg_pages_search_index AFTER INSERT OR UPDATE OF title, content, excerpt ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_search_index_sync();
INSERT INTO page_search_index (page_id, site_id, tsv)
  SELECT id, site_id, pages_build_tsv(site_id, title, excerpt, content) FROM pages
  ON CONFLICT (page_id) DO NOTHING;
