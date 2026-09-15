-- Onda I — Webhook OUT formato selezionabile per webhook (legacy vs target-style).
-- Aggiunge colonna payload_format: 'legacy' (default, {event_type,payload})
-- oppure 'target' (flat {type,eventId,eventName,locationId,<resource>...}).
-- Migrazioni future di webhook_deliveries NON necessaria: il payload viene
-- già serializzato nel formato scelto al momento dell'enqueue in enqueueForEvent().

ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS payload_format VARCHAR(10)
    NOT NULL DEFAULT 'legacy'
    CHECK (payload_format IN ('legacy', 'target'));
