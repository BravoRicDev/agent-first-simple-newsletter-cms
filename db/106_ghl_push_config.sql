-- 106: Sync bidirezionale con il CRM sorgente (GoHighLevel) — configurazione.
--
-- Estende source_sync_config con i flag del PUSH (CMS → GHL), opzionale per
-- sito e disattivato di default:
--   push_enabled   : accoda e spedisce le mutate del CMS verso GHL
--   push_direction : 'in' (solo import, default) | 'out' | 'bidirectional'
--                    ('out'/'bidirectional' attivano il push)
--   push_events    : whitelist di entity_type da spingere
--                    (default: contatti e opportunità)
-- Riusa base_url / token_enc / location_id già presenti.
--
-- Idempotente.

ALTER TABLE source_sync_config ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE source_sync_config ADD COLUMN IF NOT EXISTS push_direction VARCHAR(20) NOT NULL DEFAULT 'in';
ALTER TABLE source_sync_config ADD COLUMN IF NOT EXISTS push_events JSONB NOT NULL DEFAULT '["contact","opportunity"]';