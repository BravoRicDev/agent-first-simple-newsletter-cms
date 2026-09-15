-- 108: estendi il CHECK platform di social_posts alle piattaforme del clone
-- (il vincolo legacy db/015 prevedeva solo twitter/linkedin/facebook).
-- DO block idempotente: droppa e ricrea solo se la versione nuova manca.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'social_posts_platform_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%instagram%'
  ) THEN
    ALTER TABLE social_posts DROP CONSTRAINT social_posts_platform_check;
    ALTER TABLE social_posts ADD CONSTRAINT social_posts_platform_check
      CHECK (platform IN ('twitter','linkedin','facebook','instagram','gmb','tiktok'));
  END IF;
END
$$;
