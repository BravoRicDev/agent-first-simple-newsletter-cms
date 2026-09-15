-- 108: Push sorgente — colonna dedicata per l'ID della risorsa sul CRM sorgente.
--
-- `external_id` su contacts/opportunities è un UUID con DEFAULT gen_random_uuid()
-- (migrazione 090): funge da identificatore locale stabile, NON può ospitare
-- l'id sorgente (stringa) e non è distinguibile da un id "già importato".
-- La coda source_push_queue (107) registra comunque l'id sorgente in una colonna
-- VARCHAR; per le entità aggiungiamo `source_id` (VARCHAR) così l'id sorgente resta
-- disponibile anche fuori dalla coda (es. creazione opportunità che richiede
-- il contactId sorgente del contatto).
--
-- Idempotente.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_id VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_id VARCHAR(255) NOT NULL DEFAULT '';