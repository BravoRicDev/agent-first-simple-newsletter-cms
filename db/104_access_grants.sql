-- R1 — Permessi di accesso a contenuti protetti (vedi GAP-ANALYSIS-LEAN-REVISION.md §2).
--
-- Modello "permesso nominativo + token + scadenza": un grant consente di
-- scaricare UN file di media-protected via rotta pubblica GET /shared/:token
-- senza account CMS (lead/acquirente). media_path è il percorso RELATIVO alla
-- sottocartella del sito in media-protected (es. `video.mp4` o `corsi/lezione1.mp4`
-- → file fisico media-protected/<site_id>/<media_path>).
--
-- Vincoli chiave:
--   - expires_at NULL = nessuna scadenza temporale
--   - max_uses NULL = nessun limite di consumi (else used_count < max_uses)
--   - token UNIQUE, generato dal servizio (crypto.randomBytes, come /pay/:token)
--   - source enum: manual (admin UI) | purchase | challenge | api (agent API)
CREATE TABLE IF NOT EXISTS access_grants (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL DEFAULT '',
  token VARCHAR(64) NOT NULL UNIQUE,
  media_path VARCHAR(500) NOT NULL,
  expires_at TIMESTAMPTZ,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(30) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','purchase','challenge','api')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_access_grants_site ON access_grants(site_id);
CREATE INDEX IF NOT EXISTS idx_access_grants_email ON access_grants(site_id, email);