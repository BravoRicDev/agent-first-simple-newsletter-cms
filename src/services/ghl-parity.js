import util from "util";
import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Shadow-comparison clone vs GHL reale (db/152_ghl_parity_tracking.sql).
//
// Per ogni endpoint di lettura del clone, in background (mai bloccante per
// la risposta HTTP), confrontiamo il payload che stiamo servendo con una
// chiamata IDENTICA fatta dal vivo a GHL — finché non accumuliamo
// PARITY_THRESHOLD confronti CONSECUTIVI identici per quella coppia
// (site_id, endpoint): a quel punto smettiamo di interrogare GHL per quella
// coppia (passthrough puro). Un solo confronto diverso azzera il contatore.
//
// Budget SEPARATO (source_sync_config.shadow_*) da quello del sync
// periodico reale: la shadow-verifica non deve mai competere per la stessa
// quota, che ha priorità.
//
// Uso da un servizio "resource-clone" (es. contacts-clone.js):
//   recordComparison({
//     siteId, endpoint: "GET /contacts/:id/notes", requestKey: contact.source_id,
//     clonePayload: notesSerializzate,
//     fetchReal: () => client.get(`/contacts/${contact.source_id}/notes`, {}, { sendLocationId: false }),
//     isEquivalent: compareNotesLists,      // opzionale, default = deep-equal con eccezione "entrambi vuoti"
//   }).catch(() => {});   // mai await-ata dal chiamante: fire-and-forget
// ─────────────────────────────────────────────────────────────────────────

export const PARITY_THRESHOLD = 100;

export async function isPassthroughActive(siteId, endpoint) {
  const row = (
    await query(
      "SELECT consecutive_successes FROM ghl_parity_state WHERE site_id = $1 AND endpoint = $2",
      [siteId, endpoint]
    )
  ).rows[0];
  return (row?.consecutive_successes || 0) >= PARITY_THRESHOLD;
}

// Budget dedicato alla shadow-verifica, indipendente da consumeBudget() del
// client di sync reale (client.js) — MAI la stessa colonna/contatore.
async function consumeShadowBudget(siteId) {
  const fresh = (
    await query(
      `UPDATE source_sync_config
         SET shadow_calls_count = CASE WHEN shadow_calls_date IS DISTINCT FROM ((NOW() AT TIME ZONE 'UTC')::date) THEN 0 ELSE shadow_calls_count END + 1,
             shadow_calls_date = (NOW() AT TIME ZONE 'UTC')::date
       WHERE site_id = $1
       RETURNING shadow_calls_count, shadow_daily_quota`,
      [siteId]
    )
  ).rows[0];
  if (!fresh) return false; // nessun source_sync_config per questo sito: niente da verificare
  return fresh.shadow_calls_count <= fresh.shadow_daily_quota;
}

function isEmptyPayload(p) {
  if (Array.isArray(p)) return p.length === 0;
  if (p && typeof p === "object") return Object.keys(p).length === 0;
  return !p;
}

// Comparatore di default: deep-equal strutturale, con l'eccezione esplicita
// "entrambi vuoti" (segnalata dall'utente: un confronto vuoto-contro-vuoto
// non valida davvero la shape quando POPOLATA, va escluso dal conteggio
// invece di contare come successo debole).
function defaultIsEquivalent(clonePayload, ghlPayload) {
  if (isEmptyPayload(clonePayload) && isEmptyPayload(ghlPayload)) {
    return { equivalent: false, skipReason: "both_empty" };
  }
  return { equivalent: util.isDeepStrictEqual(clonePayload, ghlPayload), skipReason: null };
}

async function logComparison({ siteId, endpoint, requestKey, clonePayload, ghlPayload, match, skipReason }) {
  await query(
    `INSERT INTO ghl_parity_log (site_id, endpoint, request_key, clone_payload, ghl_payload, match, skip_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      siteId,
      endpoint,
      requestKey || "",
      JSON.stringify(clonePayload),
      ghlPayload === undefined ? null : JSON.stringify(ghlPayload),
      match === undefined ? null : match,
      skipReason || null,
    ]
  ).catch((err) => logger.error(`ghl-parity: log fallito (${endpoint}, site ${siteId}): ${err.message}`));
}

async function updateState(siteId, endpoint, matched) {
  if (matched) {
    const row = (
      await query(
        `INSERT INTO ghl_parity_state (site_id, endpoint, consecutive_successes, last_checked_at, updated_at)
         VALUES ($1, $2, 1, NOW(), NOW())
         ON CONFLICT (site_id, endpoint) DO UPDATE SET
           consecutive_successes = ghl_parity_state.consecutive_successes + 1,
           last_checked_at = NOW(), updated_at = NOW()
         RETURNING consecutive_successes`,
        [siteId, endpoint]
      )
    ).rows[0];
    if (row.consecutive_successes >= PARITY_THRESHOLD) {
      await query(
        `UPDATE ghl_parity_state SET passthrough_since = COALESCE(passthrough_since, NOW())
         WHERE site_id = $1 AND endpoint = $2`,
        [siteId, endpoint]
      );
    }
  } else {
    // Un solo confronto diverso azzera il contatore e fa ripartire la
    // verifica dal vivo (mai più in passthrough finché non riaccumula 100).
    await query(
      `INSERT INTO ghl_parity_state (site_id, endpoint, consecutive_successes, passthrough_since, last_checked_at, updated_at)
       VALUES ($1, $2, 0, NULL, NOW(), NOW())
       ON CONFLICT (site_id, endpoint) DO UPDATE SET
         consecutive_successes = 0, passthrough_since = NULL, last_checked_at = NOW(), updated_at = NOW()`,
      [siteId, endpoint]
    );
  }
}

/**
 * Confronta in background il payload servito con una chiamata live a GHL.
 * Pensata per essere chiamata fire-and-forget (mai await-ata dal percorso
 * di risposta HTTP): qualunque errore interno viene loggato e inghiottito,
 * non deve MAI propagare al chiamante.
 *
 * @param {object} p
 * @param {number} p.siteId
 * @param {string} p.endpoint      identificatore stabile, es. "GET /contacts/:id/notes"
 * @param {string} [p.requestKey]  solo per debug nel log (es. il source_id del contatto)
 * @param {*} p.clonePayload       quello che stiamo servendo al client
 * @param {() => Promise<*>} p.fetchReal  chiamata IDENTICA a GHL (fornita dal chiamante:
 *                                        solo lui conosce il path/parametri reali di quell'endpoint)
 * @param {(clone:*, ghl:*) => {equivalent:boolean, skipReason:?string}} [p.isEquivalent]
 */
export async function recordComparison({ siteId, endpoint, requestKey = "", clonePayload, fetchReal, isEquivalent = defaultIsEquivalent }) {
  try {
    if (await isPassthroughActive(siteId, endpoint)) return; // già al 100%: non serve più verificare

    const budgetOk = await consumeShadowBudget(siteId);
    if (!budgetOk) {
      await logComparison({ siteId, endpoint, requestKey, clonePayload, ghlPayload: undefined, match: undefined, skipReason: "shadow_budget_exhausted" });
      return;
    }

    let ghlPayload;
    try {
      ghlPayload = await fetchReal();
    } catch (err) {
      // Un errore di RETE/budget/rate-limit verso GHL non è colpa del clone:
      // non deve mai contare come mismatch (azzererebbe un contatore sano
      // per un problema estraneo alla fedeltà dello shape).
      await logComparison({ siteId, endpoint, requestKey, clonePayload, ghlPayload: undefined, match: undefined, skipReason: "ghl_call_failed" });
      return;
    }

    const { equivalent, skipReason } = isEquivalent(clonePayload, ghlPayload);
    if (skipReason) {
      await logComparison({ siteId, endpoint, requestKey, clonePayload, ghlPayload, match: undefined, skipReason });
      return;
    }

    await logComparison({ siteId, endpoint, requestKey, clonePayload, ghlPayload, match: equivalent, skipReason: null });
    await updateState(siteId, endpoint, equivalent);
  } catch (err) {
    logger.error(`ghl-parity: recordComparison fallita (${endpoint}, site ${siteId}): ${err.message}`);
  }
}
