-- Feature 29 — Runtime conversazionale per canale.
-- Agente che risponde automaticamente su WhatsApp/email/chat con regole
-- per contatto, rispettando le preferenze GDPR (contacts.pref_whatsapp /
-- pref_email / pref_phone).
--
-- Il canale whatsapp NON viene inviato dal CMS: il runtime scrive solo il
-- messaggio OUT nel registro conversazioni (conversations /
-- conversation_messages) e un bot Baileys esterno lo invia.
--
-- match: filtro contatto {contact_email, segment_id, tag} — vuoto = tutti.
-- rules: array ordinato di regole [{when:{type,text}, reply:{text,actions}}]
--   when.type ∈ contains|starts|equals|regex (case-insensitive per le prime 3)
--   actions[].type ∈ add_tag|create_task|set_stage|close_conversation
-- fallback_text: risposta quando nessuna regola matcha.
-- llm_prompt: se valorizzato e LLM configurato, genera la risposta via LLM
--   (fallback silenzioso a reply.text se LLM non disponibile).
CREATE TABLE IF NOT EXISTS agent_runtimes (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL DEFAULT '',
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('whatsapp','email','chat')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  match JSONB NOT NULL DEFAULT '{}',
  rules JSONB NOT NULL DEFAULT '[]',
  fallback_text TEXT NOT NULL DEFAULT '',
  llm_prompt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_runtimes_site_channel
  ON agent_runtimes(site_id, channel, enabled);
