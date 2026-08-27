-- Prima un fallimento SMTP ripetuto (credenziali sbagliate, host irraggiungibile)
-- lasciava una campagna bloccata in stato 'sending' a tempo indeterminato,
-- ritentata ogni 60s dallo scheduler, senza alcuna visibilità per l'admin se
-- non leggendo i log del server.
ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;
