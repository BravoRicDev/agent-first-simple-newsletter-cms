-- db/165_media_focal_points.sql
CREATE TABLE IF NOT EXISTS media_focal_points (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  x REAL NOT NULL DEFAULT 0.5 CHECK (x >= 0 AND x <= 1),
  y REAL NOT NULL DEFAULT 0.5 CHECK (y >= 0 AND y <= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, filename)
);
