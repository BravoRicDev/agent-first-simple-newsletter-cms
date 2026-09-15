-- Structured data per pagina (JSON-LD manuale, es. FAQPage, Recipe, Course, BreadcrumbList, ecc.)
-- Il campo schema_type indica il tipo (es. "FAQPage", "Recipe"), schema_json è l'oggetto completo.
-- Il CMS inietta schema_json come JSON-LD con priorità su quello auto-generato (stessa regola di injectSeoIntoStandalone).
ALTER TABLE page_seo ADD COLUMN IF NOT EXISTS schema_type VARCHAR(100);
ALTER TABLE page_seo ADD COLUMN IF NOT EXISTS schema_json JSONB;