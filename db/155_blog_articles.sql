-- Migration 155: Blog articles support (categories table + pages/blog columns + page_versions/blog columns)
-- Schema sections 2.1, 2.2, 2.3 from docs/ROADMAP-ARTICOLI.md (Phase 1)

-- 2.1: categories table
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_categories_site_id ON categories(site_id);

-- 2.2: pages blog columns (ALTER TABLE ... ADD COLUMN IF NOT EXISTS)
ALTER TABLE pages ADD COLUMN IF NOT EXISTS post_type VARCHAR(20) NOT NULL DEFAULT 'page'
  CHECK (post_type IN ('page', 'article'));
ALTER TABLE pages ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS featured_image TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS author_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS managed_by VARCHAR(50);

-- Indexes on pages (exact as described in roadmap)
CREATE INDEX IF NOT EXISTS idx_pages_post_type ON pages(site_id, post_type);
CREATE INDEX IF NOT EXISTS idx_pages_category_id ON pages(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_managed_by ON pages(site_id, managed_by) WHERE managed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_published_at ON pages(site_id, published_at DESC) WHERE post_type = 'article' AND published = true;

-- 2.3: page_versions blog columns
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS post_type VARCHAR(20) NOT NULL DEFAULT 'page';
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS category_id INTEGER;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS featured_image TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
