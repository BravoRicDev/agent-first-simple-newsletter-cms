-- 047_rbac_shifts.sql
-- Feature 28: RBAC granulare (ruoli custom), turni operatori, ricerca audit.
-- Idempotente (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS): deve poter girare
-- a vuoto su DB già migrati.

-- ── custom_roles ─────────────────────────────────────────────────────────
-- site_id: 0 = ruolo globale (nessun sito); >0 = ruolo del sito.
-- Il sentinel 0 non esiste in sites.id (SERIAL parte da 1), quindi un FK
-- diretto su site_id rifiuterebbe i ruoli globali. Soluzione: colonna
-- generata site_ref_id (NULL quando site_id = 0, altrimenti = site_id) che
-- porta l'FK con ON DELETE CASCADE: i ruoli di un sito spariscono col sito,
-- i ruoli globali restano. La validazione dell'esistenza del sito per i
-- valori >0 resta anche a livello di servizio (rbac.js) e route
-- (canAccessSite).
CREATE TABLE IF NOT EXISTS custom_roles (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL DEFAULT 0,
  name VARCHAR(255) NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  site_ref_id INTEGER GENERATED ALWAYS AS (CASE WHEN site_id = 0 THEN NULL ELSE site_id END) STORED,
  CONSTRAINT custom_roles_site_id_check CHECK (site_id >= 0),
  CONSTRAINT custom_roles_site_ref_fkey FOREIGN KEY (site_ref_id) REFERENCES sites(id) ON DELETE CASCADE,
  CONSTRAINT custom_roles_site_name_uidx UNIQUE (site_id, name)
);

-- ── users.custom_role_id ─────────────────────────────────────────────────
-- Riferimento opzionale al ruolo custom; alla cancellazione del ruolo il
-- campo torna NULL (i permessi restano quelli di base del ruolo statico).
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id INTEGER REFERENCES custom_roles(id) ON DELETE SET NULL;

-- ── operator_shifts ──────────────────────────────────────────────────────
-- Turno operatorio: giorno (0=domenica...6=sabato) + intervallo in minuti
-- da mezzanotte. CHECK (end_min > start_min) garantisce intervalli validi.
CREATE TABLE IF NOT EXISTS operator_shifts (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1439),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operator_shifts_range_check CHECK (end_min > start_min)
);

CREATE INDEX IF NOT EXISTS idx_operator_shifts_site_day_active ON operator_shifts(site_id, day_of_week, active);
