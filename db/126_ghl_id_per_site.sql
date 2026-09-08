-- 126 — Multi-sito sullo stesso CRM sorgente: da UNIQUE(ghl_id) globale a
-- UNIQUE(site_id, ghl_id) per-sito.
--
-- CONTESTO (richiesta cliente): site 21 (Lumonboy) e site 22 (ElenaCorvesi)
-- sono connessi allo stesso account/location GoHighLevel (stesso
-- location_id, stesso token — vedi source_sync_config). db/120_ghl_id_columns.sql
-- e db/124_source_sync_new_modules.sql hanno introdotto `ghl_id` con un
-- indice UNIQUE GLOBALE (non composito con site_id) su ~26 tabelle: un
-- ghl_id può esistere in UNA SOLA riga in tutto il database, indipendente
-- dal sito. Con due siti che leggono lo STESSO CRM sorgente, il secondo
-- sito a sincronizzare un dato già "preso" dal primo riceve sempre
-- "duplicate key value violates unique constraint idx_..._ghl_id" — 100%
-- di fallimento su ogni risorsa già sincronizzata dall'altro sito.
--
-- FIX (opzione "minima"): ogni sito ottiene la PROPRIA copia locale
-- indipendente degli stessi dati sorgente — stesso ghl_id può comparire
-- in righe diverse purché appartengano a siti diversi. Nessun'altra parte
-- del codice cambia: tutto il resto del CMS filtra già sempre per site_id.
--
-- Tabelle CON colonna site_id diretta: indice composito UNIQUE(site_id, ghl_id).
-- pipeline_stages e invoice_items NON hanno site_id proprio (tabelle
-- figlie, tenant derivato dal genitore — pipeline_id/invoice_id, che è già
-- una riga locale specifica del sito): composito su (pipeline_id, ghl_id) /
-- (invoice_id, ghl_id), corretto perché il genitore è già per-sito.
-- ghl_location_info NON è in questa lista: usa già site_id come PRIMARY
-- KEY (un record per sito per costruzione), nessun fix necessario.
--
-- Idempotente: DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.

DO $$
DECLARE
  t text;
  simple_tables text[] := ARRAY[
    'contacts', 'contact_notes', 'tasks', 'opportunities', 'pipelines',
    'custom_fields', 'tags', 'forms', 'form_submissions', 'surveys',
    'survey_submissions', 'users', 'calendars', 'booking_appointments',
    'conversations', 'payment_links', 'products', 'product_prices',
    'invoices', 'marketing_templates', 'newsletter_campaigns',
    'ghl_workflows', 'ghl_funnels', 'ghl_custom_values'
  ];
BEGIN
  FOREACH t IN ARRAY simple_tables LOOP
    EXECUTE format('DROP INDEX IF EXISTS idx_%I_ghl_id', t);
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_%I_ghl_id_site ON %I(site_id, ghl_id) WHERE ghl_id <> ''''',
      t, t
    );
  END LOOP;
END $$;

-- pipeline_stages: tenant derivato da pipeline_id (già locale al sito).
DROP INDEX IF EXISTS idx_pipeline_stages_ghl_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_ghl_id_pipeline
  ON pipeline_stages(pipeline_id, ghl_id) WHERE ghl_id <> '';

-- invoice_items: tenant derivato da invoice_id (già locale al sito).
DROP INDEX IF EXISTS idx_invoice_items_ghl_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_items_ghl_id_invoice
  ON invoice_items(invoice_id, ghl_id) WHERE ghl_id <> '';