-- 126 — Multi-sito sullo stesso CRM sorgente: da UNIQUE(source_id) globale a
-- UNIQUE(site_id, source_id) per-sito.
--
-- CONTESTO: site 21 e site 22
-- sono connessi allo stesso account/location CRM sorgente (stesso
-- location_id, stesso token — vedi source_sync_config). db/120_source_id_columns.sql
-- e db/124_source_sync_new_modules.sql hanno introdotto `source_id` con un
-- indice UNIQUE GLOBALE (non composito con site_id) su ~26 tabelle: un
-- source_id può esistere in UNA SOLA riga in tutto il database, indipendente
-- dal sito. Con due siti che leggono lo STESSO CRM sorgente, il secondo
-- sito a sincronizzare un dato già "preso" dal primo riceve sempre
-- "duplicate key value violates unique constraint idx_..._source_id" — 100%
-- di fallimento su ogni risorsa già sincronizzata dall'altro sito.
--
-- FIX (opzione "minima"): ogni sito ottiene la PROPRIA copia locale
-- indipendente degli stessi dati sorgente — stesso source_id può comparire
-- in righe diverse purché appartengano a siti diversi. Nessun'altra parte
-- del codice cambia: tutto il resto del CMS filtra già sempre per site_id.
--
-- Tabelle CON colonna site_id diretta: indice composito UNIQUE(site_id, source_id).
-- pipeline_stages e invoice_items NON hanno site_id proprio (tabelle
-- figlie, tenant derivato dal genitore — pipeline_id/invoice_id, che è già
-- una riga locale specifica del sito): composito su (pipeline_id, source_id) /
-- (invoice_id, source_id), corretto perché il genitore è già per-sito.
-- source_location_info NON è in questa lista: usa già site_id come PRIMARY
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
    'source_workflows', 'source_funnels', 'source_custom_values'
  ];
BEGIN
  FOREACH t IN ARRAY simple_tables LOOP
    EXECUTE format('DROP INDEX IF EXISTS idx_%I_source_id', t);
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_%I_source_id_site ON %I(site_id, source_id) WHERE source_id <> ''''',
      t, t
    );
  END LOOP;
END $$;

-- pipeline_stages: tenant derivato da pipeline_id (già locale al sito).
DROP INDEX IF EXISTS idx_pipeline_stages_source_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_source_id_pipeline
  ON pipeline_stages(pipeline_id, source_id) WHERE source_id <> '';

-- invoice_items: tenant derivato da invoice_id (già locale al sito).
DROP INDEX IF EXISTS idx_invoice_items_source_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_items_source_id_invoice
  ON invoice_items(invoice_id, source_id) WHERE source_id <> '';