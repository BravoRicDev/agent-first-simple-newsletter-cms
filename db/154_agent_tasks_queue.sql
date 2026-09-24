-- Migrazione pg_advisory_lock -> FOR UPDATE SKIP LOCKED per il tick "leggero"
-- di services/tick.js. Il lock advisory globale (72800123) faceva vincere UN
-- SOLO nodo per l'intera finestra di tick, anche in un cluster Active/Active
-- dove più nodi potrebbero contribuire in parallelo su siti diversi. Questa
-- coda per-riga usa lo stesso pattern già in produzione in webhooks.js su
-- webhook_deliveries: claim atomico con FOR UPDATE SKIP LOCKED, così due nodi
-- non prendono mai la stessa riga di lavoro, senza bisogno di un lock globale.
--
-- NON riguarda scheduler.js (batch eterogeneo di ~15 job non decomponibile in
-- righe di coda: pubblicazione pagine, backup, invii email, ecc. — il suo
-- lock advisory resta la scelta corretta, vedi docs/CLUSTER.it.md) né
-- db/migrate.js (coordinamento di boot one-shot, non ricorrente).
CREATE TABLE IF NOT EXISTS agent_tasks (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('decay', 'segment_refresh', 'workflow_delayed')),
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
  claimed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una sola riga pending/claimed per (kind, site_id): evita accodamenti
-- duplicati se il tick viene invocato più volte (o da più nodi) prima che il
-- lavoro precedente sia stato smaltito. COALESCE normalizza site_id NULL a 0
-- nell'indice (Postgres tratterebbe altrimenti ogni NULL come distinto).
CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_pending_unique
  ON agent_tasks (kind, COALESCE(site_id, 0))
  WHERE status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS agent_tasks_claim_idx
  ON agent_tasks (kind, status, run_at) WHERE status = 'pending';
