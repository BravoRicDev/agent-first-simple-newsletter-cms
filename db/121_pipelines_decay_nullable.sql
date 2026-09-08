-- 121: pipelines.decay_rate/decay_days — rimuove un NOT NULL rimasto da una
-- versione precedente e rotta della migrazione 118.
--
-- 118, alla sua prima stesura (commit 07cdb5e), dichiarava le colonne come
--   ADD COLUMN IF NOT EXISTS decay_rate NUMERIC(5,4) NOT NULL DEFAULT NULL;
-- una contraddizione SQL (NOT NULL + DEFAULT NULL). Su una tabella con righe
-- già esistenti quello statement fallisce subito (constraint violation sui
-- valori NULL già presenti); su una tabella VUOTA al momento del primo
-- deploy, invece, l'ALTER TABLE riesce e crea la colonna NOT NULL senza un
-- default utilizzabile — ogni INSERT successivo che non valorizzi
-- esplicitamente decay_rate/decay_days (compreso il source-sync, che non
-- conosce questi campi: sono configurazione locale del CMS) fallisce con
-- "null value in column ... violates not-null constraint".
--
-- Il fix successivo (commit b952505) ha corretto 118 togliendo il NOT NULL
-- dalla dichiarazione — ma ADD COLUMN IF NOT EXISTS è un no-op quando la
-- colonna esiste già: su un DB dove 118 era già girata (nella versione
-- rotta) il vincolo NOT NULL non viene mai davvero rimosso da una semplice
-- ri-esecuzione. Serve un ALTER COLUMN esplicito.
--
-- Idempotente: DROP NOT NULL su una colonna già nullable (o inesistente,
-- se la tabella non ha mai avuto la colonna) è un no-op sicuro.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pipelines' AND column_name = 'decay_rate') THEN
    ALTER TABLE pipelines ALTER COLUMN decay_rate DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pipelines' AND column_name = 'decay_days') THEN
    ALTER TABLE pipelines ALTER COLUMN decay_days DROP NOT NULL;
  END IF;
END $$;
