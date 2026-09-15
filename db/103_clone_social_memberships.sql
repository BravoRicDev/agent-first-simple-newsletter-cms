-- 103 — Clone API, Onda H: Social accounts, memberships, courses,
-- enrollments + external_id parity per social_posts (già ufficiale da
-- db/015_social_posts.sql). Recuperata da file di lavoro mai committati
-- (vedi nota in 097_clone_sites_columns.sql). Idempotente: tutti gli ADD
-- COLUMN IF NOT EXISTS e CREATE TABLE IF NOT EXISTS.

-- 1. External ID + status per social_posts (parità clone API).
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS external_id UUID;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'scheduled'
  CHECK (status IN ('scheduled', 'posted', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_external_id
  ON social_posts(external_id) WHERE external_id IS NOT NULL;

-- 2. Social accounts: registrazione account su piattaforme (solo lo stato,
-- non le credenziali).
CREATE TABLE IF NOT EXISTS social_accounts (
  id SERIAL PRIMARY KEY,
  external_id UUID NOT NULL DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  platform VARCHAR(30) NOT NULL CHECK (platform IN ('facebook','instagram','linkedin','twitter','gmb','tiktok')),
  account_name VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected')),
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, platform)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_accounts_external_id
  ON social_accounts(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_accounts_site_platform
  ON social_accounts(site_id, platform);

-- 3. Memberships: piani di iscrizione/abbonamento.
CREATE TABLE IF NOT EXISTS memberships (
  id SERIAL PRIMARY KEY,
  external_id UUID NOT NULL DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'EUR',
  billing_interval VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (billing_interval IN ('monthly','yearly','one_time')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_external_id
  ON memberships(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memberships_site_active
  ON memberships(site_id, active);

-- 4. Courses: contenuti/corsi associati a membership.
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  external_id UUID NOT NULL DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  membership_id INTEGER REFERENCES memberships(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_external_id
  ON courses(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_courses_site_membership
  ON courses(site_id, membership_id);

-- 5. Enrollments: iscrizioni di contatti a membership/courses.
CREATE TABLE IF NOT EXISTS enrollments (
  id SERIAL PRIMARY KEY,
  external_id UUID NOT NULL DEFAULT gen_random_uuid(),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(membership_id, contact_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_external_id
  ON enrollments(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enrollments_site_contact
  ON enrollments(site_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_membership_status
  ON enrollments(membership_id, status);
