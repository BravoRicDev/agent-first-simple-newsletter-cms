-- Vhost API dedicato per tenant (Fase 0 clone API): un dominio dedicato
-- (es. apicrm.esempio.it) instrada l'intero traffico di quell'host al router
-- clone root-level invece delle pagine pubbliche del sito. Facoltativo:
-- NULL = nessun vhost API per quel sito (comportamento invariato).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS api_domain VARCHAR(255);

-- Indice unique parziale: un dominio API può appartenere a un solo sito,
-- ma più siti possono avere api_domain NULL (nessun vhost dedicato).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_api_domain ON sites(api_domain) WHERE api_domain IS NOT NULL;
