-- ONDA 2 Phase 6 — Event-driven agent conversation triggers
-- Aggiunge event_triggers JSONB a agent_runtimes per trigger automatici su eventi
-- (booking_created, contact_created, form_submitted, ecc.)

ALTER TABLE agent_runtimes
  ADD COLUMN IF NOT EXISTS event_triggers JSONB NOT NULL DEFAULT '[]'::jsonb;