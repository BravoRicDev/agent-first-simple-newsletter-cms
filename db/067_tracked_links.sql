-- Feature 39 — Link tracciati (QR / link corto) per sito.
--
-- Un link pubblico /go/:slug che conta le visite e reindirizza (302) verso
-- una destinazione. Ogni sito ha i suoi link (isolamento per site_id).
-- Analogo ai "magic link" di CRM lato import:
--   - conteggio visite (totali + uniche per giorno)
--   - collegamento al funnel tramite channel / utm_campaign: il primo
--     contatto che arriva da un link eredita quella sorgente (first_source
--     su contacts), rendendo il link un canale misurabile nel funnel.
--   - identificazione opzionale del visitatore: se il link riceve un
--     parametro ?email= o ?cid= l'evento registra il contatto (per vedere
--     chi ha cliccato e se ha convertito).
--   - QR code: ogni link attivo espone l'endpoint QR (/go/:slug.qr) che
--     genera un PNG dal relativo URL pubblico.
CREATE TABLE IF NOT EXISTS tracked_links (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label VARCHAR(255) NOT NULL DEFAULT '',
  slug VARCHAR(120) NOT NULL DEFAULT '',
  target_url TEXT NOT NULL DEFAULT '',
  channel VARCHAR(255) NOT NULL DEFAULT '',
  utm_campaign VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | paused
  qr_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_links_site_slug ON tracked_links(site_id, slug);
CREATE INDEX IF NOT EXISTS idx_tracked_links_site_created
  ON tracked_links(site_id, created_at DESC);

-- Eventi visita: ogni hit al link /go/:slug. email è vuota se il visitatore
-- non è identificato (no ?email= / ?cid=).
CREATE TABLE IF NOT EXISTS tracked_link_events (
  id SERIAL PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL DEFAULT '',
  ip VARCHAR(64) NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracked_link_events_link_created
  ON tracked_link_events(link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracked_link_events_link_email
  ON tracked_link_events(link_id, email);
