import { query, getClient } from "../../db.js";
import { logger } from "../logger.js";
import { loadConfig, createSourceClient, SourceBudgetError } from "./client.js";
import * as contactsMapper from "./mappers/contacts.js";

// ─────────────────────────────────────────────────────────────────────────
// Orchestratore source-sync (docs/SOURCE_SYNC_PLAN.md).
// Esegue i mapper nell'ordine delle dipendenze e coordina la "caccia"
// ricorsiva: le submission form/survey che referenziano contatti assenti
// locali fanno scattare il fetch singolo + la caccia delle figlie.
// ─────────────────────────────────────────────────────────────────────────

const SWEEP_ORDER = [
  "users",
  "custom-fields",
  "tags",
  "pipelines",
  "calendars",
  "contacts",
  "forms",
  "surveys",
  "campaigns",
  "commerce",
];

async function loadMappers() {
  // Import dinamici: i file mapper sono gestiti da agenti/fasi successive;
  // un modulo assente viene semplicemente saltato con warning.
  const names = {
    users: "./mappers/users.js",
    "custom-fields": "./mappers/custom-fields.js",
    tags: "./mappers/tags.js",
    pipelines: "./mappers/pipelines.js",
    calendars: "./mappers/calendars.js",
    contacts: "./mappers/contacts.js",
    forms: "./mappers/forms.js",
    surveys: "./mappers/surveys.js",
    campaigns: "./mappers/campaigns.js",
    commerce: "./mappers/commerce.js",
  };
  const loaded = {};
  for (const [key, path] of Object.entries(names)) {
    try {
      loaded[key] = await import(path);
    } catch (err) {
      if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
      logger.warn(`source-sync: mapper ${key} non presente (${path})`);
    }
  }
  return loaded;
}

function makeCtx(siteId, cfg, client, { dryRun }) {
  const stats = {};
  const addStat = (res, key, n = 1) => {
    stats[res] = stats[res] || { fetched: 0, upserted: 0, updated: 0, skipped: 0, errors: 0 };
    stats[res][key] = (stats[res][key] || 0) + n;
  };
  return {
    siteId,
    cfg,
    client,
    dryRun,
    stats,
    /** contatti la cui caccia è fallita: NON riprovati nei round successivi
     *  (previene loop infiniti se il sorgente continua a referenziarli) */
    failedContacts: new Set(),
    addStat,
    /** uuid sorgente dei contatti presenti localmente */
    knownContacts: new Set(),
    /** contatti scoperti (submission) ancora non cacciati */
    discoveredContacts: new Set(),
    log: (...a) => logger.info(`source-sync[${siteId}]:`, ...a),
  };
}

async function loadKnownContacts(siteId) {
  const r = await query("SELECT external_id FROM contacts WHERE site_id = $1 AND external_id IS NOT NULL", [siteId]);
  return new Set(r.rows.map((x) => x.external_id));
}

/**
 * Caccia delle risorse figlie per un lotto di contatti (per-contatto API del
 * sorgente). Chiamata dall'orchestratore dopo ogni pagina di contatti e dopo
 * ogni round di discovery.
 */
async function huntSubresources(mappers, ctx, extIds) {
  if (!extIds.length) return;
  const sub = [
    ["contacts", "syncForContacts"], // note + tasks (dentro il mapper contatti)
    ["opportunities", "syncForContacts"],
    ["conversations", "syncForContacts"],
    ["calendars", "syncAppointmentsForContacts"],
  ];
  for (const [key, fn] of sub) {
    const mod = mappers[key];
    if (mod && typeof mod[fn] === "function") {
      await mod[fn](ctx, extIds);
    }
  }
}

export async function runSync(siteId, { resources = null, dryRun = false, mode = null } = {}) {
  const cfg = await loadConfig(siteId);
  if (!cfg || !cfg.enabled) {
    return { ok: false, reason: "not_enabled" };
  }

  // Advisory lock per-site su connessione DEDICATA: il lock è legato alla
  // connessione. Prima usava query() sul pool condiviso: se la connessione
  // tornava nel pool col lock ancora attivo, quel lock NON veniva mai
  // rilasciato davvero (i sync successivi dello stesso tenant restavano
  // "already_running"), oppure l'unlock finiva su un'altra connessione e
  // due sync paralleli potevano girare insieme. Con getClient() il lock
  // vive su una connessione che teniamo aperta per tutto il run.
  const lockKey = hashtext(`source-sync:${siteId}`);
  let lockClient = null;
  let locked = false;
  try {
    lockClient = await getClient();
    const lockRes = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
    if (!lockRes.rows[0]?.locked) {
      lockClient.release();
      lockClient = null;
      return { ok: false, reason: "already_running" };
    }
    locked = true;

    const requested = Array.isArray(resources) && resources.length ? resources : SWEEP_ORDER;
    const runRow = (
      await query(
        "INSERT INTO source_sync_runs (site_id, mode, resources) VALUES ($1,$2,$3) RETURNING id",
        [siteId, mode || (dryRun ? "dry" : "full"), requested]
      )
    ).rows[0];

    let ctx;
    let status = "ok";
    let error = null;

    try {
      const client = createSourceClient(cfg);
      ctx = makeCtx(siteId, cfg, client, { dryRun });
      ctx.knownContacts = await loadKnownContacts(siteId);

      const mappers = await loadMappers();

      // Sweep principale nell'ordine di dipendenza. contacts usa una hook di
      // pagina: dopo ogni pagina caccia subito le figlie (memoria costante).
      for (const key of SWEEP_ORDER) {
        if (!requested.includes(key)) continue;
        const mod = mappers[key];
        if (!mod || typeof mod.syncAll !== "function") continue;
        try {
          if (key === "contacts") {
            await mod.syncAll(ctx, async (pageExtIds) => {
              await huntSubresources(mappers, ctx, pageExtIds);
            });
          } else {
            await mod.syncAll(ctx);
          }
        } catch (err) {
          if (err instanceof SourceBudgetError) throw err;
          logger.error(`source-sync: mapper ${key} fallito: ${err.message}`);
          ctx.addStat(key, "errors", 1);
        }
      }

      // Ricorsione: submission che referenziano contatti sconosciuti
      let guard = 0;
      while (ctx.discoveredContacts.size > 0 && guard < 50) {
        guard++;
        const batch = [...ctx.discoveredContacts].slice(0, 50);
        for (const id of batch) ctx.discoveredContacts.delete(id);
        const fresh = [];
        for (const extId of batch) {
          if (ctx.knownContacts.has(extId)) continue;
          if (ctx.failedContacts.has(extId)) continue; // già tentato e fallito
          if (typeof contactsMapper.fetchSingle === "function") {
            const row = await contactsMapper.fetchSingle(ctx, extId);
            if (row) {
              fresh.push(extId);
              ctx.knownContacts.add(extId);
            } else {
              // fetch fallito/404: non riprovare ai round successivi
              ctx.failedContacts.add(extId);
            }
          }
        }
        await huntSubresources(mappers, ctx, fresh);
      }

      // Watermark/statistiche per risorsa
      for (const res of Object.keys(ctx.stats)) {
        await query(
          `INSERT INTO source_sync_state (site_id, resource_type, watermark, last_run_at, last_status, last_counts)
           VALUES ($1,$2,NOW(),NOW(),'ok',$3)
           ON CONFLICT (site_id, resource_type) DO UPDATE SET
             watermark = NOW(), last_run_at = NOW(), last_status = 'ok', last_counts = $3`,
          [siteId, res, JSON.stringify(ctx.stats[res])]
        );
      }
    } catch (err) {
      status = err instanceof SourceBudgetError ? "budget_exhausted" : "error";
      error = err.message;
      logger.error(`source-sync run ${runRow.id} errore: ${err.message}`);
    } finally {
      await query(
        `UPDATE source_sync_runs SET status=$2, finished_at=NOW(), stats=$3, errors=$4 WHERE id=$1`,
        [
          runRow.id,
          status,
          JSON.stringify(ctx?.stats || {}),
          JSON.stringify(error ? [{ error }] : []),
        ]
      );
    }

    return { ok: status === "ok" || status === "budget_exhausted", status, stats: ctx?.stats || {}, error };
  } finally {
    if (locked && lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      } catch (err) {
        logger.error(`source-sync: unlock fallito (site ${siteId}): ${err.message}`);
      }
      lockClient.release();
    }
  }
}

/** Due run ravvicinati non devono sovrapporsi: usato anche dalle route manuali. */
export async function isRunning(siteId) {
  const r = await query(
    "SELECT 1 FROM source_sync_runs WHERE site_id=$1 AND status='running' AND started_at > NOW()-interval '6 hours' LIMIT 1",
    [siteId]
  );
  return r.rows.length > 0;
}

function hashtext(str) {
  // pg_try_advisory_lock accetta bigint: hashtext non esiste lato JS,
  // usiamo un hash numerico stabile semplice.
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ── Cron S4: siti con sync abilitato e intervallo scaduto ───────────────
// Chiamata dallo scheduler a ogni tick; avvia al massimo un run per sito
// (in-memory set + advisory lock in runSync come seconda barriera).
const activeSites = new Set();

export async function runSourceSyncDue() {
  const due = (
    await query(
      `SELECT c.site_id
         FROM source_sync_config c
        WHERE c.enabled = true
          AND (
            c.calls_date IS DISTINCT FROM (CURRENT_DATE AT TIME ZONE 'UTC')
            OR c.calls_count < FLOOR(c.daily_quota * c.budget_percent / 100.0)
          )
          AND COALESCE(
                (SELECT MAX(r.started_at) FROM source_sync_runs r WHERE r.site_id = c.site_id),
                'epoch'
              ) <= NOW() - make_interval(mins => GREATEST(c.min_interval_minutes, 1))
        LIMIT 5`
    )
  ).rows;

  let started = 0;
  for (const row of due) {
    const siteId = row.site_id;
    if (activeSites.has(siteId)) continue;
    activeSites.add(siteId);
    started++;
    runSync(siteId)
      .catch((err) => logger.error(`source-sync cron site ${siteId}: ${err.message}`))
      .finally(() => activeSites.delete(siteId));
  }
  return { started };
}
