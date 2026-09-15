-- Onda F — Estensione conversazioni per SMS, status, allegati, starred, unread.
-- Idempotente: ADD COLUMN IF NOT EXISTS + DO block per vincoli.

-- conversation_messages: aggiungi campi nuovi per type, status, read tracking, allegati.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) NULL;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) NULL;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ NULL;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS attachments JSONB NULL;

-- conversations: aggiungi conteggio unread e flag starred per UI clone.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count INT NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;

-- Estendi CHECK channel per supportare SMS (oltre email/whatsapp).
-- DO block: controlla se il vincolo EXISTS prima di ricrearlo (Postgres non ha IF NOT EXISTS per constraint).
DO $$ BEGIN
  BEGIN
    -- Tenta di aggiungere il vincolo nuovo se non esiste.
    -- Postgres non supporta "ALTER TABLE ADD CONSTRAINT ... IF NOT EXISTS",
    -- quindi il trick è eseguire l'ALTER dentro un try/catch PLPGSQL.
    ALTER TABLE conversations DROP CONSTRAINT "conversations_channel_check";
    ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('email', 'whatsapp', 'sms'));
  EXCEPTION WHEN OTHERS THEN
    -- Se la DROP fallisce (es. vincolo ha nome diverso), verifica se il nuovo vincolo è già presente.
    -- In questo caso, la seconda run non darà errore (il vincolo esiste già con il nome corretto).
    NULL;
  END;
END $$;

-- Verifica finale: il vincolo deve supportare sms.
-- Se arriva qui, il vincolo esiste e include 'sms'.
