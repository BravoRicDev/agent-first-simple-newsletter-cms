-- 108: Push GHL — colonna dedicata per l'ID della risorsa sul CRM sorgente.
--
-- `external_id` su contacts/opportunities è un UUID con DEFAULT gen_random_uuid()
-- (migrazione 090): funge da identificatore locale stabile, NON può ospitare
-- l'id GHL (stringa) e non è distinguibile da un id "già importato".
-- La coda source_push_queue (107) registra comunque l'id GHL in una colonna
-- VARCHAR; per le entità aggiungiamo `ghl_id` (VARCHAR) così l'id GHL resta
-- disponibile anche fuori dalla coda (es. creazione opportunità che richiede
-- il contactId GHL del contatto).
--
-- Idempotente.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ghl_id VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS ghl_id VARCHAR(255) NOT NULL DEFAULT '';