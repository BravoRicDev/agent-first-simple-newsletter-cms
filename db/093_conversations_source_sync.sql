-- 093: estensioni conversazioni per il source-sync, copiate da
-- db/100_conversations_clone.sql del repo sorgente. Il mapper conversazioni
-- (conversations.js) normalizza i canali sorgente TYPE_* a 'sms' quando non
-- sono email/whatsapp, quindi il CHECK su channel deve ammettere 'sms'.
-- Idempotente (ADD COLUMN IF NOT EXISTS + DO block per il vincolo).

-- conversation_messages: campi aggiuntivi per type/status/read/allegati.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) NULL;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) NULL;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ NULL;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS attachments JSONB NULL;

-- conversations: conteggio unread e flag starred per la UI clone.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count INT NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;

-- Estendi CHECK channel per supportare SMS (oltre email/whatsapp).
-- Postgres non supporta ADD CONSTRAINT ... IF NOT EXISTS, quindi il trick è
-- DROP dentro un try/catch PLPGSQL.
DO $$ BEGIN
  BEGIN
    ALTER TABLE conversations DROP CONSTRAINT "conversations_channel_check";
    ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('email', 'whatsapp', 'sms'));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;
