-- BLOCCO C: Soppressione non-ingaggio, configurabile per campagna e sequenza.
-- Parametri per escludere chi non ha aperto nessuno degli ultimi N invii ricevuti.

-- Newsletter campaigns: toggle soppressione e soglia in giorni di storico.
ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS suppress_inactive BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS inactive_after_sends INT NOT NULL DEFAULT 0;

-- Newsletter sequences: stessa configurazione, per escludere inattivi da ogni step.
ALTER TABLE newsletter_sequences ADD COLUMN IF NOT EXISTS suppress_inactive BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE newsletter_sequences ADD COLUMN IF NOT EXISTS inactive_after_sends INT NOT NULL DEFAULT 0;
