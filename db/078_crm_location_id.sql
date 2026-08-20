-- 078 — mapping Location CRM ↔ Site.
--
-- Aggiunge a `sites` il campo `crm_location_id`: l'identificativo della
-- "location"  associata a questo sito. Quando un nodo n8n passa
-- quel dato (header Location-Id), il middleware requireTenant lo usa per
-- risolvere il sito, così la location CRM identifica il tenant del CMS.
--
-- UNIQUE e NULLABLE: una location può appartenere a una sola site, e un site
-- può non avere il mapping (nil dati CRM).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS crm_location_id VARCHAR(255);

-- Indice univoco parziale: unicità solo sulle righe con valore (permette più NULL).
CREATE UNIQUE INDEX IF NOT EXISTS sites_crm_location_id_key
  ON sites (crm_location_id)
  WHERE crm_location_id IS NOT NULL;
