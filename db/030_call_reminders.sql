-- Traccia se il promemoria è già stato inviato per una chiamata, per non
-- rispedirlo ad ogni giro dello scheduler (stesso pattern di
-- pages.reminder_sent per i promemoria di revisione pagina).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
