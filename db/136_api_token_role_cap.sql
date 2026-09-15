-- Tetto ruolo opzionale per gli API token (agtok_). Idempotente.
--
-- Un token con role_cap impostato opera col ruolo MINORE tra quello
-- dell'utente proprietario e il cap:
--   superadmin/admin + cap → il token agisce come cap (perde l'accesso ai
--                            siti non assegnati e agli endpoint superadmin)
--   altri ruoli + cap      → cap ignorato (mai elevazione di privilegi)
--
-- Caso d'uso: consegnare un satellite/integrazione a terzi senza esporre i
-- contenuti del CMS. Prassi consigliata: utente di servizio con site_id del
-- satellite giusto + token capped su quel sito.

ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS role_cap VARCHAR(20);

-- CHECK idempotente via DO block (ADD CONSTRAINT non supporta IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_tokens_role_cap_check') THEN
    ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_role_cap_check
      CHECK (role_cap IN ('admin', 'collaboratore'));
  END IF;
END $$;

COMMENT ON COLUMN api_tokens.role_cap IS 'Tetto ruolo del token (admin|collaboratore|NULL=ruolo pieno). Puo solo abbassare, mai elevare.';
