-- Area clienti generica (P0 ridotto): "cliente" = contatto marcato,
-- "servizio" = voce di catalogo configurabile, stato attivo/disattivato
-- per cliente. Il CMS resta generico: un servizio esterno (area clienti
-- dedicata) interrogherà le API agent per sapere se un cliente ha accesso
-- a un servizio. Nessun concetto specifico di un'agenzia.

-- 1) Contatto marcabile come cliente: is_client + client_status
--    ('inactive' | 'active' | 'suspended'). Default: non cliente.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_client BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_status VARCHAR(20) NOT NULL DEFAULT 'inactive';

-- 2) Catalogo servizi (generico): es. 'portale', 'whatsapp', 'calendario'.
--    La chiave è stabile (usata dalle API di verifica accesso), la label è
--    il nome mostrato. Nessun seed: lo popola l'admin/agente.
CREATE TABLE IF NOT EXISTS services_catalog (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Servizi assegnati ai clienti: riga per coppia (contatto, servizio).
--    active=false = disattivato (deactivated_at valorizzato).
--    config JSONB libero per parametri futuri del servizio (es. limiti).
CREATE TABLE IF NOT EXISTS client_services (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services_catalog(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ,
  config JSONB,
  UNIQUE(contact_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_client_services_contact ON client_services(contact_id);
