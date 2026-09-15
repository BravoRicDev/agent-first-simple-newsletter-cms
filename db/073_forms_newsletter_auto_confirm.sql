-- Doppio opt-in disattivabile per form: ogni form decide se iscrivere subito come 'confirmed'
-- o con doppio opt-in. Default FALSE = doppio opt-in attivo (comportamento attuale).

ALTER TABLE forms ADD COLUMN IF NOT EXISTS newsletter_auto_confirm BOOLEAN NOT NULL DEFAULT false;
