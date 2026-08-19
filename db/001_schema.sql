CREATE TABLE IF NOT EXISTS sites (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255) NOT NULL UNIQUE,
  layout_template VARCHAR(50) DEFAULT 'site',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL DEFAULT '',
  role VARCHAR(50) NOT NULL DEFAULT 'admin' CHECK (role IN ('superadmin','admin','collaboratore')),
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pages (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url_path TEXT NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  layout_mode VARCHAR(20) NOT NULL DEFAULT 'wrapped' CHECK (layout_mode IN ('standalone','wrapped')),
  published BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, url_path)
);

CREATE TABLE IF NOT EXISTS snippets (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, name)
);

CREATE TABLE IF NOT EXISTS magic_links (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) NOT NULL,
  otp VARCHAR(6) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token);
CREATE INDEX IF NOT EXISTS idx_magic_links_user_id ON magic_links(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  entity_type VARCHAR(100) NOT NULL,
  entity_id INTEGER,
  action VARCHAR(20) NOT NULL,
  old_data JSONB,
  new_data JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_site_id ON audit_log(site_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  UNIQUE(site_id, key)
);

CREATE TABLE IF NOT EXISTS roles_permissions (
  id SERIAL PRIMARY KEY,
  role VARCHAR(50) NOT NULL,
  resource VARCHAR(100) NOT NULL,
  can_create BOOLEAN NOT NULL DEFAULT false,
  can_read BOOLEAN NOT NULL DEFAULT false,
  can_update BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(role, resource)
);

INSERT INTO roles_permissions (role, resource, can_create, can_read, can_update, can_delete) VALUES
  ('admin', 'sites', false, true, true, false),
  ('admin', 'pages', true, true, true, true),
  ('admin', 'snippets', true, true, true, true),
  ('admin', 'users', true, true, true, true),
  ('admin', 'settings', false, true, true, false),
  ('collaboratore', 'pages', true, true, true, true),
  ('collaboratore', 'snippets', true, true, true, true),
  ('collaboratore', 'users', false, true, false, false),
  ('collaboratore', 'settings', false, true, false, false)
ON CONFLICT DO NOTHING;
