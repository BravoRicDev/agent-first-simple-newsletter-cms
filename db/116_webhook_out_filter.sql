-- 116: Webhook OUT con filtro condizioni payload + azioni workflow send_webhook/add_note/emit_event.
-- filter: JSONB di condizioni per inoltrare la delivery SOLO se il payload matcha.
--   Formato: { "form_slug": "qualifica-lead", "to_stage": "cliente" }  → inclusione
--            { "!tag": "spam" }                                       → esclusione
--   Semantica: tutte le condizioni devono matchare (AND). Valore con prefisso `!` = deve NON essere uguale.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS filter JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_webhooks_site_filter ON webhooks(site_id, direction) WHERE filter <> '{}'::jsonb;