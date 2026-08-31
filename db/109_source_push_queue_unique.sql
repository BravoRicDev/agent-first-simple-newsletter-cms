-- 109: Push GHL — anti-duplicato sull'enqueue dell'outbox.
--
-- Indice parziale UNIQUE su (site_id, entity_type, entity_id) per le righe
-- pending/sending: due enqueue concorrenti dello stesso contatto/opportunità
-- (es. due aggiornamenti paralleli) non possono accodare la stessa entità
-- due volte (altrimenti lo stesso cambio verrebbe spinto due volte a GHL).
-- L'INSERT in source-sync/push.js usa ON CONFLICT DO NOTHING su questo target.
--
-- Idempotente.

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_push_queue_pending_entity
  ON source_push_queue(site_id, entity_type, entity_id)
  WHERE status IN ('pending', 'sending');