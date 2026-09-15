-- Valore stimato dell'affare per il modulo pipeline vendite. Sullo stesso
-- contatto (non una tabella a parte): è un attributo singolo, non una
-- collezione, stesso ragionamento già fatto per tags/status/notes.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS value_estimate NUMERIC(12,2);
