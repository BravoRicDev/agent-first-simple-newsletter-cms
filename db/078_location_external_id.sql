-- 078 — mapping Location ↔ Site (identificativo esterno della location).
--
-- Un nodo esterno (es. un'automazione n8n) può passare nell'header
-- `Location-Id` l'identificativo della "location" per identificare il sito/
-- tenant del CMS giusto. Questo campo su `sites` contiene quell'identificativo
-- esterno (UUID della location nel sistema esterno) associato a questo sito.
--
-- Naming volutamente GENERICO (`location_external_id`): compatibile con "API
-- compatibili con CRM diffusi", nessuna traccia del nome del CRM di origine.
--
-- UNIQUE e NULLABLE: una location esterna appartiene a una sola site, e un
-- site può non avere mapping (nessun dato esterno). Più NULL ammessi grazie
-- all'indice univoco parziale.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS location_external_id VARCHAR(255);

-- Indice univoco parziale: unicità solo sulle righe con valore (permette più NULL).
CREATE UNIQUE INDEX IF NOT EXISTS sites_location_external_id_key
  ON sites (location_external_id)
  WHERE location_external_id IS NOT NULL;
