-- 095: UUID esterno per sites — sorgente canonica del "locationId" esposto
-- dalle API clone quando il tenant non ha configurato location_external_id.
-- Vedi docs/API_CLONE_MASTER_PLAN.md §4.2 e _helpers.getLocationId().
ALTER TABLE sites ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_external_id
  ON sites(external_id)
  WHERE external_id IS NOT NULL;
