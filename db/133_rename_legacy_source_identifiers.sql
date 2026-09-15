-- 131 — Allineamento identificatori "legacy" al naming corrente `source_*`.
--
-- Contesto: le versioni precedenti dello schema usavano il prefisso "ghl" per
-- gli identificatori interni (colonne/tabelle/indici) relativi al CRM
-- sorgente. Il naming interno è stato unificato su `source_*` (coerente con
-- source_sync_config / source_push_queue / source_message_id). Questo file
-- esiste SOLO per allineare i database creati prima della rinomina: su un
-- database nuovo (dove le migration girano già con i nomi `source_*`) è un
-- no-op.
--
-- Idempotente: rinomina solo se il nome legacy esiste e il nuovo nome no.

DO $$
DECLARE
  r record;
  newname text;
BEGIN
  -- 1) Colonne il cui nome contiene il prefisso legacy.
  FOR r IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND position('ghl' in column_name) > 0
  LOOP
    newname := replace(r.column_name, 'ghl', 'source');
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = r.table_name AND column_name = newname
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME COLUMN %I TO %I', r.table_name, r.column_name, newname);
    END IF;
  END LOOP;

  -- 2) Tabelle.
  FOR r IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND position('ghl' in tablename) > 0
  LOOP
    newname := replace(r.tablename, 'ghl', 'source');
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = newname) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', r.tablename, newname);
    END IF;
  END LOOP;

  -- 3) Indici.
  FOR r IN
    SELECT c.relname AS idxname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'i' AND n.nspname = 'public' AND position('ghl' in c.relname) > 0
  LOOP
    newname := replace(r.idxname, 'ghl', 'source');
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = newname
    ) THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.idxname, newname);
    END IF;
  END LOOP;

  -- 4) Sequence.
  FOR r IN
    SELECT c.relname AS seqname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S' AND n.nspname = 'public' AND position('ghl' in c.relname) > 0
  LOOP
    newname := replace(r.seqname, 'ghl', 'source');
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S' AND n.nspname = 'public' AND c.relname = newname
    ) THEN
      EXECUTE format('ALTER SEQUENCE public.%I RENAME TO %I', r.seqname, newname);
    END IF;
  END LOOP;

  -- 5) Constraint (PK/FK/UNIQUE/CHECK).
  FOR r IN
    SELECT c.conname, cl.relname AS tablename
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'public' AND position('ghl' in c.conname) > 0
  LOOP
    newname := replace(r.conname, 'ghl', 'source');
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname = 'public' AND c.conname = newname AND cl.relname = r.tablename
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tablename, r.conname, newname);
    END IF;
  END LOOP;
END $$;

-- 6) Valori di dati: l'origine evento `ghl_in` diventa `source_in`.
UPDATE webhook_deliveries SET origin = 'source_in' WHERE origin = 'ghl_in';
UPDATE source_push_queue   SET origin = 'source_in' WHERE origin = 'ghl_in';
