import { query } from "../db.js";
import { logger } from "./logger.js";
import { processDelayedActions } from "./workflows.js";
import { applyScoreDecay } from "./scoring.js";
import { refreshSegments } from "./segments.js";

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
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_DECAY_EVERY = 10;
const DEFAULT_SEGMENT_REFRESH_EVERY = 5;
const DELAYED_ACTIONS_LIMIT = 50;

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

// runDecay/runSegments: true/false forzano l'esecuzione (o lo skip) del
// relativo step indipendentemente dal contatore — usato dall'endpoint per
// permettere un run mirato (es. test, o riallineamento manuale).
export async function runTick(siteId = null, { runDecay = null, runSegments = null } = {}) {
  tickCounter++;

  const decayEvery = await getGlobalTickInterval("tick_scoring_decay_every", DEFAULT_DECAY_EVERY);
  const segmentEvery = await getGlobalTickInterval("tick_segment_refresh_every", DEFAULT_SEGMENT_REFRESH_EVERY);

  const shouldDecay = runDecay !== null ? runDecay : tickCounter % decayEvery === 0;
  const shouldRefreshSegments = runSegments !== null ? runSegments : tickCounter % segmentEvery === 0;

  const result = {
    tick: tickCounter,
    delayed_actions: { executed: 0 },
    scoring_decay: null,
    segment_refresh: null,
  };

  try {
    result.delayed_actions = await processDelayedActions(siteId, { limit: DELAYED_ACTIONS_LIMIT });
  } catch (err) {
    logger.error(`Tick: azioni differite fallite: ${err.message}`);
  }

  if (shouldDecay) {
    try {
      result.scoring_decay = await applyScoreDecay(siteId);
    } catch (err) {
      logger.error(`Tick: scoring decay fallito: ${err.message}`);
    }
  }

  if (shouldRefreshSegments) {
    try {
      result.segment_refresh = await refreshSegments(siteId);
    } catch (err) {
      logger.error(`Tick: refresh segmenti fallito: ${err.message}`);
    }
  }

  return result;
}

// Uso solo nei test, per un contatore deterministico tra i vari "it".
export function resetTickCounter() {
  tickCounter = 0;
}
