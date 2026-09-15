-- Scope di accesso per gli API token (agtok_). Idempotente.
--
-- Un token può essere:
--   {read}          → sola lettura sulle API esposte ai satelliti/automazioni
--   {read, write}   → anche creazione/aggiornamento dati (opportunità,
--                     contatti, ...) nei limiti dei permessi del ruolo
--                     dell'utente proprietario (RBAC del CMS).
--
-- DEFAULT retrocompatibile: i token esistenti nascono con entrambi gli scope
-- perché finora un agtok_ ereditava integralmente il ruolo dell'utente —
-- revocare la scrittura a posteriori romperebbe integrazioni in produzione
-- (n8n, moduli satellite). I token NUOVI creati dall'admin UI nascono
-- invece read-only: la scrittura è un opt-in esplicito.

ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['read', 'write']::text[];

COMMENT ON COLUMN api_tokens.scopes IS 'Scope del token ("read", "write"). Default legacy = entrambi; token nuovi = sola lettura, scrittura opt-in.';
