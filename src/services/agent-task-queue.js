import { getClient, query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Coda task generica su tabella (`agent_tasks`, db/154_agent_tasks_queue.sql),
// claim atomico via FOR UPDATE SKIP LOCKED: sostituisce, per il tick leggero
// di tick.js, il pattern "un solo lock advisory globale vince l'intera
// finestra di tick" con "ogni riga di lavoro viene presa da un solo nodo".
// Stesso approccio già usato da webhooks.js su webhook_deliveries.
//
// NOTA nome file: non "tasks.js" — quel nome è già usato da
// services/tasks.js (task vendite/kanban + funnel snapshot, dominio
// completamente diverso).
// ─────────────────────────────────────────────────────────────────────────

const STALE_CLAIM_MINUTES = 10;

// Accoda un task se non ne esiste già uno pending/claimed per la stessa
// coppia (kind, site_id) — vedi indice unico in migrazione. ON CONFLICT DO
// NOTHING rende la chiamata sicura da invocare ad ogni tick senza duplicare
// lavoro non ancora smaltito.
export async function enqueueTask(kind, siteId = null) {
  await query(
    `INSERT INTO agent_tasks (kind, site_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [kind, siteId]
  );
}

// Recupero worker morto: una riga rimasta 'claimed' oltre STALE_CLAIM_MINUTES
// (processo crashato dopo il claim, prima del completamento) torna 'pending'
// per un nuovo tentativo. Stesso pattern del reaper in webhooks.js.
export async function retireExhausted() {
  await query(
    `UPDATE agent_tasks SET status = 'pending', claimed_at = NULL
     WHERE status = 'claimed' AND claimed_at < NOW() - interval '${STALE_CLAIM_MINUTES} minutes'`
  );
}

// Claim atomico: marca 'claimed' fino a `limit` righe pending e dovute per
// (kind, site_id), escluse da qualunque altro worker/nodo concorrente
// (FOR UPDATE SKIP LOCKED). IMPORTANTE: filtrato per site_id (IS NOT
// DISTINCT FROM, per matchare anche i task globali con site_id NULL) — un
// claim NON scoped per sito potrebbe altrimenti prendere il task di un
// sito diverso da quello del chiamante, sovrascrivendone il risultato
// (bug trovato in verifica isolata prima del deploy: la coda ha SEMPRE al
// più una riga pending per (kind, site_id) grazie all'indice unico, quindi
// scoping per sito qui non toglie nulla al parallelismo cross-nodo — nodi
// diversi restano liberi di lavorare in parallelo su siti diversi).
export async function claimTasks(kind, siteId = null, limit = 20) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `WITH due AS (
         SELECT id FROM agent_tasks
         WHERE kind = $1 AND site_id IS NOT DISTINCT FROM $2
           AND status = 'pending' AND run_at <= NOW()
         ORDER BY run_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE agent_tasks t SET status = 'claimed', claimed_at = NOW(), attempts = attempts + 1
       FROM due WHERE t.id = due.id
       RETURNING t.id, t.site_id`,
      [kind, siteId, limit]
    );
    await client.query("COMMIT");
    return claim.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function completeTask(id, { error = null } = {}) {
  if (error) {
    await query(
      `UPDATE agent_tasks SET status = 'failed', last_error = $2 WHERE id = $1`,
      [id, String(error).slice(0, 500)]
    );
  } else {
    await query(`UPDATE agent_tasks SET status = 'done' WHERE id = $1`, [id]);
  }
}
