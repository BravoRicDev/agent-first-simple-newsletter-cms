-- 123: custom_fields.name troppo stretta (VARCHAR(255)) — stesso problema
-- della migrazione 122 (field_key), un campo residuo dopo quel fix: alcuni
-- nomi campo del CRM sorgente superano 255 caratteri (testo integro della
-- domanda). Dopo 122+123: custom-fields sincronizzati 111/111, 0 errori
-- (verificato dal vivo dal report che ha individuato il bug).
--
-- Idempotente (ALTER COLUMN TYPE su una colonna già text è un no-op).

ALTER TABLE custom_fields ALTER COLUMN name TYPE text;
