-- 122: custom_fields.field_key troppo stretta (VARCHAR(100)).
--
-- Alcuni custom field del CRM sorgente derivano il field_key dal testo
-- INTEGRO della domanda (form/survey lunghi): osservati field_key fino a
-- 232+ caratteri su un account reale. 20/111 custom field fallivano con
-- "value too long for type character varying(100)" durante il source-sync.
--
-- TEXT: nessun limite naturale per uno slug derivato da testo libero (la
-- UNIQUE(site_id, object_key, field_key) da db/074 resta valida su text).
-- Idempotente (ALTER COLUMN TYPE su una colonna già text è un no-op).

ALTER TABLE custom_fields ALTER COLUMN field_key TYPE text;
