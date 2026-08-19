-- Moduli opzionali attivabili per sito (pipeline vendite, chiamate, ecc.):
-- un'installazione multi-sito può avere clienti diversi con esigenze
-- diverse, quindi il toggle è per sito, non per installazione (a differenza
-- di flag come STATIC_EXPORT_ENABLED in .env, validi per tutta l'istanza).
-- Assente = disattivato (default false), niente riga da creare in anticipo
-- per ogni sito.
CREATE TABLE IF NOT EXISTS site_modules (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  module_key VARCHAR(50) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, module_key)
);
