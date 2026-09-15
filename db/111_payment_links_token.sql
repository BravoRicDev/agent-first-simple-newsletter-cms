-- 111: payment_links.token — UNIQUE globale con DEFAULT '' causa collisione.
--
-- Il mapper source-sync commerce importa payment_links senza token: con
-- DEFAULT '' e indice UNIQUE globale, il primo importato prende '' e il
-- secondo (anche di un altro sito) viola l'UNIQUE → import bloccato.
-- Fix: indice UNIQUE PARZIALE solo su token non vuoto + backfill di token
-- casuali per le righe esistenti con token = ''. Il mapper ora genera un
-- token a ogni INSERT (vedi mappers/commerce.js).
--
-- Idempotente (DROP IF EXISTS + CREATE IF NOT EXISTS + UPDATE puntuale).

DROP INDEX IF EXISTS idx_payment_links_token;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_token
  ON payment_links(token)
  WHERE token <> '';

UPDATE payment_links
   SET token = md5(gen_random_uuid()::text || clock_timestamp()::text)
 WHERE token = '';