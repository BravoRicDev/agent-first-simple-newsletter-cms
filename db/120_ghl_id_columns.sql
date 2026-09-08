-- 120: doppio id per il source-sync — ghl_id dedicato, external_id intoccato.
--
-- BUG (produzione, 2026-09-07/08): il source-sync (docs/SOURCE_SYNC_PLAN.md)
-- scriveva l'id ESATTO della risorsa sul CRM sorgente stile GoHighLevel
-- (stringa alfanumerica di 20 caratteri, es. "eMjqNVexkS7CyIM2qdtg", niente
-- trattini) nella colonna `external_id` — che la migrazione 090 ha però
-- tipizzato UUID (DEFAULT gen_random_uuid()) per uno scopo del tutto diverso
-- e incompatibile: l'identificatore locale stabile per il futuro "clone API
-- totale" (docs/API_CLONE_MASTER_PLAN.md §4.2, mai agganciato a nessuna
-- route: src/services/external-ids.js, ensureExternalId/findByExternalId
-- senza chiamanti). Risultato: ogni upsert/lookup del source-sync su queste
-- tabelle falliva con "invalid input syntax for type uuid" — mascherato per
-- settimane da un bug separato nel logger (vedi src/services/source-sync/index.js).
--
-- FIX SCELTO — doppio id, MAI condiviso: invece di allargare external_id a
-- text (che lo terrebbe comunque concettualmente condiviso fra due scopi
-- incompatibili, e romperebbe l'invariante "external_id = id locale" già
-- usato altrove — vedi src/services/opportunities.js, src/services/privacy.js),
-- estendiamo a tutte le tabelle toccate dal source-sync il pattern già
-- introdotto dalla migrazione 108 solo per contacts/opportunities: una
-- colonna `ghl_id` (VARCHAR, testo libero, default '' = mai sincronizzato)
-- SEPARATA, dedicata all'id del CRM sorgente. `external_id` resta sempre e
-- solo l'id locale del CMS, il source-sync non la tocca mai, in nessuna
-- tabella — necessario anche per la casistica del cliente: un sito CMS può
-- essere collegato a GoHighLevel A POSTERIORI (record già esistenti con un
-- proprio id locale), quindi i due id non devono e non possono coincidere.
--
-- Elenco tabelle: verificato leggendo il codice (grep di `table: "..."` in
-- upsertByExternalId/findInternalId + INSERT/UPDATE/SELECT diretti) in
-- src/services/source-sync/{upsert,index,push}.js e
-- src/services/source-sync/mappers/*.js. Non è l'elenco di WHITELIST_TABLES
-- (src/services/external-ids.js), molto più ampio e a uso del clone API
-- dormiente: qui solo le tabelle che il source-sync scrive DAVVERO.
--
-- contacts/opportunities hanno già `ghl_id` (migrazione 108): ADD COLUMN
-- IF NOT EXISTS è no-op lì, ma mancava l'indice univoco parziale, aggiunto
-- qui per tutte. Idempotente.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'contacts', 'contact_notes', 'tasks', 'opportunities',
    'pipelines', 'pipeline_stages', 'custom_fields', 'tags',
    'forms', 'form_submissions', 'surveys', 'survey_submissions',
    'users', 'calendars', 'booking_appointments', 'conversations',
    'payment_links', 'products', 'product_prices', 'invoices',
    'invoice_items', 'marketing_templates', 'newsletter_campaigns'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS ghl_id VARCHAR(255) NOT NULL DEFAULT ''''', t
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_%I_ghl_id ON %I(ghl_id) WHERE ghl_id <> ''''', t, t
    );
  END LOOP;
END $$;
