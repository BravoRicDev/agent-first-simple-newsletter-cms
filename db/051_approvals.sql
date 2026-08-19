-- Feature 32 — Human-in-the-loop: coda di approvazione.
-- L'agente AI non esegue azioni sensibili (inviare messaggi out, creare
-- task, modificare contatti, lanciare campagne) senza il via libera di un
-- umano: enqueue nella coda, l'operatore approva/rifiuta da UI o API, e
-- solo all'approvazione viene eseguito il payload (o restituito un errore
-- di azione se l'esecuzione fallisce, senza mai bloccare la decisione).
--
-- payload JSONB libero: nessuna FK verso conversation/task, il formato è
-- deciso dal chiamante e validato dal servizio hitl.js all'approvazione.
CREATE TABLE IF NOT EXISTS approval_queue (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL DEFAULT 'custom'
    CHECK (kind IN ('outbound_message','task','quote','campaign','contact_change','custom')),
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  requested_by VARCHAR(255) NOT NULL DEFAULT '',
  decided_by VARCHAR(255) DEFAULT '',
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_approval_queue_site_status_created
  ON approval_queue(site_id, status, created_at DESC);
