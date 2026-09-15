-- 105: Single-fire safety per le delivery webhook OUT + origine eventi.
--
-- 1. Colonna `origin` su webhook_deliveries: da dove nasce l'evento
--    ('cms' | 'agent' | 'source_in' | 'import'). Usata per l'anti-echo del push
--    verso il CRM sorgente: gli eventi originati da sorgente non
--    vengono rispediti a sorgente (prevenzione cascate/loop di automazioni).
-- 2. Status 'sending': il claim atomico multi-nodo dell'outbox (pattern
--    "SELECT ... FOR UPDATE SKIP LOCKED" + UPDATE) marca le righe come in
--    consegna, cosicché due istanze Active/Active non spediscano mai la
--    stessa delivery due volte.
--
-- Idempotente (IF NOT EXISTS / DROP IF EXISTS + re-CREATE CHECK).

ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'cms';

-- Ricrea il CHECK consentendo lo stato intermedio 'sending'.
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_status_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed'));