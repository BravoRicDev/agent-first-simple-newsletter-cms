-- Migration 157: custom_css per categoria (CSS iniettato nelle card del
-- widget {{articles:...}}, roadmap §10). NULL/vuoto = nessun CSS aggiuntivo.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS custom_css TEXT;
