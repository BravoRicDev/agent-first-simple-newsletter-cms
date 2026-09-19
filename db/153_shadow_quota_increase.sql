-- Aumento budget shadow-comparison (services/ghl-parity.js): estesa a molti
-- più endpoint in questo round, 200/giorno per sito non basta più a
-- verificarli tutti. 2000/giorno resta ben sotto il budget del sync reale
-- (250000/giorno), le chiamate di verifica non competono mai con quelle vere.
ALTER TABLE source_sync_config ALTER COLUMN shadow_daily_quota SET DEFAULT 2000;
UPDATE source_sync_config SET shadow_daily_quota = 2000 WHERE shadow_daily_quota < 2000;
