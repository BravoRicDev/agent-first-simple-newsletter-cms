-- 097 — Clone API: colonne base su sites.
-- Recuperate da file di lavoro mai committati (esistevano solo su un server
-- di sviluppo, mai in git) — riformalizzate qui su richiesta del developer
-- dopo che il merge del pacchetto clone API su un DB pulito (solo le
-- migrazioni ufficiali) ha fallito per schema mancante. Numerata nel gap
-- libero 097-103 (nessuna migrazione ufficiale lo usa) e non oltre 119:
-- db/120_ghl_id_columns.sql itera ALTER TABLE su marketing_templates/
-- newsletter_campaigns senza gestione d'errore per tabella mancante — le
-- tabelle create da questo gruppo di migrazioni (097-103) devono esistere
-- PRIMA che 120 giri, altrimenti 120 fallisce con "relation ... does not
-- exist" su un DB migrato da zero.

-- Vhost API dedicato per tenant (Fase 0 clone API): un dominio dedicato
-- (es. apicrm.esempio.it) instrada l'intero traffico di quell'host al
-- router clone root-level invece delle pagine pubbliche del sito.
-- Facoltativo: NULL = nessun vhost API per quel sito (comportamento
-- invariato). Vedi src/middleware/api-host.js.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS api_domain VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_api_domain
  ON sites(api_domain) WHERE api_domain IS NOT NULL;

-- UUID esterno per sites — sorgente canonica del "locationId" esposto dalle
-- API clone quando il tenant non ha configurato location_external_id
-- (colonna diversa, già ufficiale da db/078_location_external_id.sql).
-- Vedi src/routes/api-clone/_helpers.js getLocationId().
ALTER TABLE sites ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_external_id
  ON sites(external_id) WHERE external_id IS NOT NULL;
