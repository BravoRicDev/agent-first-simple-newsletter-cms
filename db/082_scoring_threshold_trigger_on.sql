-- ONDA2 Phase 6: le soglie di scoring possono scattare sia quando il
-- punteggio SALE sopra min_score (comportamento esistente, default 'above')
-- sia quando SCENDE sotto min_score per effetto del decadimento
-- (applyScoreDecay) — usato per azioni di "raffreddamento lead" (es. rimuovi
-- tag, notifica).
ALTER TABLE scoring_thresholds ADD COLUMN IF NOT EXISTS trigger_on VARCHAR(10) NOT NULL DEFAULT 'above';
