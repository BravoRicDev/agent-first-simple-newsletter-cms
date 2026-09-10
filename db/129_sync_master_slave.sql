-- 129: rapporto master/slave ESPlicito per la clonazione "sito gemello"
-- (source-sync). Sostituisce la scelta ambigua basata sui conteggi contatti.
--
-- BUG (produzione, 2026-09-10): findSiblingWithContacts decideva chi clona da
-- chi SOLO in base a chi ha PIÙ contatti già sincronizzati (ORDER BY COUNT DESC
-- LIMIT 1). Con due siti sullo stesso account GHL e conteggi UGUALI (site 21 e
-- site 22, entrambi 14592) la scelta era arbitraria e SIMMETRICA: entrambi
-- potevano decidere di clonare dall'altro ⇒ NESSUNO chamava più GHL per i
-- contatti ⇒ dati fermi per sempre (verificato dal vivo).
--
-- FIX: relazione master/slave ESPLICITa e asimmetrica, colonna per-sito su
-- source_sync_config:
--   sync_master_site_id IS NULL ⇒ il sito è MASTER (o standalone): chiama
--           SEMPRE il CRM sorgente reale, non clona mai da un sibling.
--   sync_master_site_id = <id>  ⇒ il sito è SLAVE del master <id>: clona SEMPRE
--           dal master quando è abilitato, senza guardare alcun conteggio.
-- Scelta della colonna "slave che punta al master" (invece di un booleano
-- is_sync_master) perché è più esplicita e ammette N slave con master diversi
-- in futuro (una relazione booleana non direbbe DA CHI clonare).
--
-- Vincoli:
--   * un sito non può essere master di sé stesso (CHECK);
--   * catene NON supportate: il master puntato deve a sua volta avere
--     sync_master_site_id IS NULL — validato in resolveSiblingSource (runtime)
--     e nella PUT config agent (set-time), non qui con SQL (dipenderebbe da
--     UPDATE concorrenti);
--   * ON DELETE SET NULL: se il sito master viene cancellato, gli slave
--     tornano master/standalone (chiamano GHL da soli) invece di rompersi.

ALTER TABLE source_sync_config
  ADD COLUMN IF NOT EXISTS sync_master_site_id INT REFERENCES sites(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'source_sync_config_master_not_self'
  ) THEN
    ALTER TABLE source_sync_config
      ADD CONSTRAINT source_sync_config_master_not_self
      CHECK (sync_master_site_id IS NULL OR sync_master_site_id <> site_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_source_sync_config_master
  ON source_sync_config(sync_master_site_id)
  WHERE sync_master_site_id IS NOT NULL;

-- Seed ambiente attuale (coerente con la produzione odierna): site 21
-- (Lumonboy, il sito sul vhost apicrm.* su cui si testa il clone-API) = MASTER
-- (sync_master_site_id resta NULL); site 22 (ElenaCorvesi) = SLAVE di 21.
-- Idempotente e sicuro anche su DB (es. test) dove quei siti non esistono:
-- imposta solo se site 22 esiste, non ha già un master, e site 21 esiste come
-- master (a sua volta senza master).
UPDATE source_sync_config slave
   SET sync_master_site_id = 21, updated_at = NOW()
  WHERE slave.site_id = 22
    AND slave.sync_master_site_id IS NULL
    AND EXISTS (
      SELECT 1 FROM source_sync_config m
       WHERE m.site_id = 21 AND m.sync_master_site_id IS NULL
    );
