-- Migration 158: override manuale opzionale del tempo di lettura stimato
-- per un articolo (minuti). NULL = usa la stima automatica
-- (estimateReadingTime, src/services/blog-index.js). Serve per siti che
-- vogliono controllare esattamente il valore mostrato (es. riprodurre un
-- calcolo storico diverso dalla stima a parole/minuto), non e' specifico
-- per nessun sito in particolare.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS reading_time_minutes INTEGER;
