-- UNIQUE(site_id, key) non impedisce righe duplicate quando site_id è NULL
-- (Postgres non considera NULL = NULL in un vincolo di unicità), quindi il
-- pattern UPDATE-poi-INSERT non atomico usato per le impostazioni globali
-- poteva creare righe duplicate sotto richieste concorrenti. Prima di creare
-- l'indice univoco parziale, ripulisce eventuali duplicati già presenti
-- tenendo la riga più recente (id più alto) per ciascuna key globale.
DELETE FROM settings a
USING settings b
WHERE a.site_id IS NULL AND b.site_id IS NULL
  AND a.key = b.key
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS settings_global_key_uidx ON settings (key) WHERE site_id IS NULL;
