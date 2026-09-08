-- 127 — conversation_messages.source_message_id: da UNIQUE globale a
-- UNIQUE(conversation_id, source_message_id).
--
-- Trovato testando dal vivo la clonazione locale tra siti gemelli
-- (src/services/source-sync/clone-sibling.js, db/126_ghl_id_per_site.sql):
-- idx_conversation_messages_source_id era UNIQUE(source_message_id) da solo
-- (db/... schema originale, mai toccato da 120/126 — conversation_messages
-- non era nella lista delle tabelle "ghl_id per source-sync", ha invece
-- source_message_id come proprio identificatore univoco del messaggio sul
-- CRM sorgente). Con due siti sullo stesso account GHL, lo STESSO messaggio
-- (stesso source_message_id) deve poter esistere in DUE righe diverse — una
-- per conversazione/sito — ma l'indice globale lo impediva silenziosamente
-- (ON CONFLICT ... DO NOTHING scartava la riga della clonazione senza
-- errore, la conversazione clonata restava senza messaggi). Anche
-- semanticamente più corretto: un id messaggio è univoco ALL'INTERNO della
-- sua conversazione, non nell'intero database.
--
-- conversation_messages non ha una colonna site_id propria (tenant
-- derivato da conversation_id → conversations.site_id, già locale al
-- sito), stesso pattern già usato per pipeline_stages/invoice_items in
-- db/126_ghl_id_per_site.sql.

DROP INDEX IF EXISTS idx_conversation_messages_source_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_source_id_conv
  ON conversation_messages(conversation_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
