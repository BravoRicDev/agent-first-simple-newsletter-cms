-- Estensione del registro sso_satellites per la comunicazione tra satelliti:
-- discovery delle capability, proxy sincrono /invoke ed eventi (inbox).
-- Idempotente (IF NOT EXISTS), come le migrazioni 084-086.
--
-- capabilities : array JSON [{ method, path, desc, scope }] — API esposte dal
--                satellite, interrogabili via GET /api/agent/satellites(/:name)/capabilities
-- webhooks     : array JSON [{ event, url, secret_ref }] — push eventi futuro (F2, opzionale)
-- base_internal: URL sulla rete Docker interna (es http://satellite-app:3103) usato
--                SOLO dal proxy del CMS; MAI l'origin pubblico (quello resta per l'SSO)
-- agent_token_enc: token M2M del satellite target, cifrato aes-256-gcm con la chiave
--                ENCRYPTION_KEY del CMS (mai in chiaro in DB, mai in risposta API)
-- user_id      : utente di servizio proprietario dell'agtok_ del satellite — lega il
--                token al nome satellite (inbox per-target, X-Satellite-Caller)

ALTER TABLE sso_satellites
  ADD COLUMN IF NOT EXISTS capabilities    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS webhooks        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS base_internal   TEXT,
  ADD COLUMN IF NOT EXISTS agent_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Interrogazioni future sulle capability (contiene, @>, esistenza chiavi)
CREATE INDEX IF NOT EXISTS idx_sso_satellites_capab ON sso_satellites USING GIN (capabilities);

COMMENT ON COLUMN sso_satellites.capabilities IS 'API dichiarate dal satellite: [{method, path, desc, scope}] (discovery + whitelist del proxy)';
COMMENT ON COLUMN sso_satellites.base_internal IS 'URL rete interna Docker usato dal proxy del CMS; NULL = proxy non raggiungibile';
