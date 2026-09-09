-- Dedicated override for the standard Meta Pixel "CompleteRegistration" event,
-- independent from the generic leadEventName/leadPages/track_lead mechanism,
-- required to be able to enable this specific event on individual pages
-- without touching the site's generic lead configuration.
ALTER TABLE page_tracking_overrides
  ADD COLUMN IF NOT EXISTS track_complete_registration BOOLEAN;