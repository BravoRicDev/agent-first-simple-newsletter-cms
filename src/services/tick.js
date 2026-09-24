import { query } from "../db.js";
import { logger } from "./logger.js";
import { processDelayedActions } from "./workflows.js";
import { applyScoreDecay } from "./scoring.js";
import { refreshSegments } from "./segments.js";
import { enqueueTask, retireExhausted, claimTasks, completeTask } from "./agent-task-queue.js";

// ─────────────────────────────────────────────────────────────────────────
// ONDA2 Phase 6 — tick "on demand" esposto via POST /api/agent/tick, per
// invocazione esterna (cron/CLI) oltre allo scheduler interno (setInterval
// in scheduler.js, che già chiama processDelayedActions/applyScoreDecay ad
// ogni giro). Orchestrata qui in un unico punto:
//   1. azioni differite dei workflow scadute (wait_days) — ad OGNI tick,
//      LIMIT 50 (operazione leggera, deve smaltire la coda in tempo).
//   2. decadimento scoring — ogni N tick (pesante: scansiona i contatti).
//   3. refresh segmenti dinamici — ogni M tick (pesante: O(email × regole)).
// N/M configurabili via settings globali (site_id IS NULL):
// tick_scoring_decay_every / tick_segment_refresh_every.
//
// MIGRAZIONE FOR UPDATE SKIP LOCKED (v2): in precedenza un unico lock
// advisory globale (pg_try_advisory_lock, chiave 72800123) decideva quale
// nodo, in un cluster Active/Active, eseguisse TUTTO il lavoro di questa
// finestra di tick — gli altri nodi saltavano l'intero giro. Ora il lavoro
// viene accodato riga per riga in `agent_tasks` (db/154_agent_tasks_queue.sql)
// e ogni nodo fa un claim atomico con FOR UPDATE SKIP LOCKED (tasks.js):
// nessun nodo resta bloccato fuori dal lavoro, e due nodi non prendono mai
// la stessa riga. Stesso pattern già in produzione in webhooks.js su
// webhook_deliveries. Vedi docs/CLUSTER.it.md.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_DECAY_EVERY = 10;
const DEFAULT_SEGMENT_REFRESH_EVERY = 5;
const DELAYED_ACTIONS_LIMIT = 50;
const CLAIM_LIMIT = 10;

// Contatore in-process: azzerato ad ogni riavvio del processo (comportamento
// accettabile per un throttling best-effort, non serve persistenza).
let tickCounter = 0;

async function getGlobalTickInterval(key, fallback) {
  const row = (await query(
    "SELECT value FROM settings WHERE site_id IS NULL AND key = $1",
    [key]
  )).rows[0];
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function runClaimedTasks(kind, siteId, run, onResult) {
  // Claim scoped al siteId di questa chiamata: per (kind, site_id) esiste al
  // più una riga pending grazie all'indice unico, quindi CLAIM_LIMIT qui
  // serve solo a coprire l'eventuale riga singola, mai task di altri siti.
  const claims = await claimTasks(kind, siteId, CLAIM_LIMIT);
  for (const task of claims) {
    try {
      const result = await run(task.site_id ?? siteId);
      onResult(result);
      await completeTask(task.id);
    } catch (err) {
      logger.error(`Tick: task '${kind}' fallito: ${err.message}`);
      await completeTask(task.id, { error: err.message });
    }
  }
}

// runDecay/runSegments: true/false forzano l'esecuzione (o lo skip) del
// relativo step indipendentemente dal contatore — usato dall'endpoint per
// permettere un run mirato (es. test, o riallineamento manuale).
export async function runTick(siteId = null, { runDecay = null, runSegments = null } = {}) {
  // Recupero worker morto: eventuali task rimasti 'claimed' da un nodo
  // crashato prima del completamento tornano disponibili.
  await retireExhausted();

  tickCounter++;

  const decayEvery = await getGlobalTickInterval("tick_scoring_decay_every", DEFAULT_DECAY_EVERY);
  const segmentEvery = await getGlobalTickInterval("tick_segment_refresh_every", DEFAULT_SEGMENT_REFRESH_EVERY);

  const shouldDecay = runDecay !== null ? runDecay : tickCounter % decayEvery === 0;
  const shouldRefreshSegments = runSegments !== null ? runSegments : tickCounter % segmentEvery === 0;

  // Accoda il lavoro dovuto in questa finestra. L'indice unico su
  // (kind, site_id) per le righe pending/claimed evita duplicati se più
  // invocazioni (o più nodi) arrivano nella stessa finestra.
  await enqueueTask("workflow_delayed", siteId);
  if (shouldDecay) await enqueueTask("decay", siteId);
  if (shouldRefreshSegments) await enqueueTask("segment_refresh", siteId);

  const result = {
    tick: tickCounter,
    skipped: false,
    delayed_actions: { executed: 0 },
    scoring_decay: null,
    segment_refresh: null,
  };

  await runClaimedTasks(
    "workflow_delayed",
    siteId,
    (sid) => processDelayedActions(sid, { limit: DELAYED_ACTIONS_LIMIT }),
    (r) => { result.delayed_actions = r; }
  );

  await runClaimedTasks(
    "decay",
    siteId,
    (sid) => applyScoreDecay(sid),
    (r) => { result.scoring_decay = r; }
  );

  await runClaimedTasks(
    "segment_refresh",
    siteId,
    (sid) => refreshSegments(sid),
    (r) => { result.segment_refresh = r; }
  );

  return result;
}

// Uso solo nei test, per un contatore deterministico tra i vari "it".
export function resetTickCounter() {
  tickCounter = 0;
}
