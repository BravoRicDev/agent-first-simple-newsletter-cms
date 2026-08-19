-- SEO: canonical URL override, noindex flag, OG image override per pagina.
ALTER TABLE page_seo ADD COLUMN IF NOT EXISTS canonical_url TEXT;
ALTER TABLE page_seo ADD COLUMN IF NOT EXISTS noindex BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE page_seo ADD COLUMN IF NOT EXISTS og_image TEXT;
