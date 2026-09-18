-- Traccia l'ultimo tentativo di sync on-demand delle note di un contatto
-- (src/services/contacts-clone.js#getContactNotes): usata per throttlare a
-- 20 minuti le chiamate live a GHL quando la scheda contatto/note risulta
-- sospetta (contatto senza note pur essendo sincronizzato). Aggiornata sia
-- su successo che su fallimento del tentativo, per non ritentare ad ogni
-- richiesta se il sorgente è irraggiungibile o il budget è esaurito.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes_synced_at TIMESTAMPTZ NULL;
