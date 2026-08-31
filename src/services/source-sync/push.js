import { query, getClient } from "../../db.js";
import { logger } from "../logger.js";
import { loadConfig, createSourceClient } from "./client.js";

// ─────────────────────────────────────────────────────────────────────────
// Push bidirezionale verso il CRM sorgente (GoHighLevel) — CMS → GHL.
//
// Ogni mutazione rilevante del CMS (contatto creato/aggiornato/taggato,
// opportunità creata/aggiornata/spostata/eliminata) viene accodata in
// source_push_queue (outbox). Un processor (dallo scheduler o dall'endpoint
// agent) la svuota con le garanzie "FIRING-ONCE IN CLUSTER":
//
//   1. canFire() — lease per-sito (advisory lock): UN SOLO nodo processa
//      per sito in ogni finestra; se un altro nodo è in possesso, salta.
//   2. canFire() — niente import in corso per il sito (source_sync_runs
//      running) e replica DB al passo (standby non indietro): non si spara
//      mentre i dati stanno ancora arrivando dal sorgente.
//   3. Claim atomico FOR UPDATE SKIP LOCKED (status 'sending'): due nodi
//      non prendono MAI la stessa riga.
//   4. ANTI-ECHO: le mutate con origine 'ghl_in'/'import' NON vengono mai
//      rispedite a GHL (evita cascate A→GHL→A→GHL…).
//
// La feature è OPZIONALE per sito (source_sync_config.push_enabled +
// push_direction 'out'/'bidirectional'); con default 'in' non accoda nulla.
// ─────────────────────────────────────────────────────────────────────────

const PUSH_MAX_ATTEMPTS = 5;
const NO_ECHO_ORIGINS = new Set(["ghl_in", "import"]);
// Base della chiave advisory per-sito: PUSH_LOCK_KEY_BASE + siteId (bigint).
const PUSH_LOCK_KEY_BASE = 74830000;
// Tolleranza lag replica (o standby arretrato) sotto cui NON si spara.
const REPLICA_LAG_TOLERANCE_BYTES = 128 * 1024 * 1024; // 128MB di WAL

/**
 * Accoda una mutata da propagare a GHL. Idempotente/aggressiva-dedup:
 * se per la stessa entità esiste già una riga pending/sending, non ne
 * crea un'altra (il processor prenderà lo stato più recente dal DB).
 *
 * @param {number} siteId
 * @param {string} entityType 'contact' | 'opportunity'
 * @param {object} opts { entityId, email, operation='upsert', externalId='', origin='cms' }
 */
export async function enqueuePush(siteId, entityType, opts = {}) {
  if (!siteId || !entityType) return { queued: 0 };
  const cfg = await loadConfig(siteId);
  if (!cfg || !cfg.push_enabled) return { queued: 0 };
  if (cfg.push_direction === "in") return { queued: 0 };

  const origin = NO_ECHO_ORIGINS.has(opts.origin) ? opts.origin : "cms";
  // ANTI-ECHO: nulla che arriva da GHL/import torna a GHL.
  if (NO_ECHO_ORIGINS.has(origin)) return { queued: 0, skipped: "no-echo" };

  // Whitelist push_events (parti da ['contact','opportunity']).
  let pushEvents = cfg.push_events;
  if (typeof pushEvents === "string") {
    try { pushEvents = JSON.parse(pushEvents); } catch { pushEvents = []; }
  }
  if (!Array.isArray(pushEvents)) pushEvents = [];
  if (pushEvents.length > 0 && !pushEvents.includes(entityType)) {
    return { queued: 0, skipped: "not-in-whitelist" };
  }

  let entityId = parseInt(opts.entityId, 10) || null;
  if (!entityId && opts.email && entityType === "contact") {
    const r = await query(
      "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
      [siteId, String(opts.email).trim().toLowerCase()]
    );
    entityId = r.rows[0]?.id || null;
  }
  if (!entityId) return { queued: 0, skipped: "no-entity" };

  const operation = ["upsert", "delete"].includes(opts.operation) ? opts.operation : "upsert";
  const externalId = String(opts.externalId || "").slice(0, 255);

  // Dedup: entità già in coda (pending/sending) → non accodare di nuovo.
  // L'indice parziale 109 (UNIQUE su site_id/entity_type/entity_id dove
  // status IN ('pending','sending')) rende la dedup ATOMICA anche con
  // enqueue concorrenti (TOCTOU): il SELECT qui sotto è solo un fast-path
  // per non scrivere inutilmente; la garanzia vera è l'ON CONFLICT.
  const existing = (await query(
    `SELECT 1 FROM source_push_queue
     WHERE site_id = $1 AND entity_type = $2 AND entity_id = $3
       AND status IN ('pending','sending') LIMIT 1`,
    [siteId, entityType, entityId]
  )).rows[0];
  if (existing) return { queued: 0, deduped: true };

  const inserted = await query(
    `INSERT INTO source_push_queue (site_id, entity_type, entity_id, external_id, operation, origin)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id, entity_type, entity_id) WHERE status IN ('pending','sending')
     DO NOTHING
     RETURNING id`,
    [siteId, entityType, entityId, externalId, operation, origin]
  );
  return inserted.rowCount > 0 ? { queued: 1 } : { queued: 0, deduped: true };
}

// ── Guardia "fire unico + niente sync in corso" ──────────────────────────
// Il lock viene tenuto da processPushQueue su una connessione dedicata per
// tutto il giro; qui verifichiamo che nessun ALTRO sync sia in corso.
async function noImportRunning(siteId) {
  const r = await query(
    `SELECT 1 FROM source_sync_runs
     WHERE site_id = $1 AND status = 'running' AND started_at > NOW() - interval '6 hours'
     LIMIT 1`,
    [siteId]
  );
  return r.rows.length === 0;
}

async function replicaCaughtUp() {
  // Solo se questa connessione è uno standby ha senso il check; sul leader
  // (configurazione cluster scelta: app → Patroni leader) è già "al passo".
  const r = await query(
    `SELECT pg_is_in_recovery() AS in_recovery,
            COALESCE(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0) AS lag_bytes
       FROM (SELECT 1) x`
  );
  if (!r.rows[0]?.in_recovery) return true;
  const lag = Number(r.rows[0].lag_bytes) || 0;
  return lag <= REPLICA_LAG_TOLERANCE_BYTES;
}

// ── Mappatori inversi (locale → GHL) ─────────────────────────────────────
const PROFILE_KEYS = new Set(["name", "firstName", "lastName", "phone", "companyName", "website"]);

async function loadContactForPush(siteId, id) {
  const row = (
    await query(
      `SELECT c.id, c.email, c.tags, c.status, c.notes, c.ghl_id, cv.values AS custom_values
       FROM contacts c
       LEFT JOIN contact_custom_values cv
         ON cv.site_id = c.site_id AND cv.contact_id = c.id AND cv.object_key = 'contact'
       WHERE c.id = $1 AND c.site_id = $2`,
      [id, siteId]
    )
  ).rows[0];
  if (!row) return null;
  let cv = row.custom_values || {};
  if (typeof cv === "string") { try { cv = JSON.parse(cv); } catch { cv = {}; } }

  const custom = [];
  for (const [key, value] of Object.entries(cv)) {
    if (PROFILE_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    const def = (
      await query(
        "SELECT external_id FROM custom_fields WHERE site_id = $1 AND field_key = $2 AND object_key = 'contact' AND external_id IS NOT NULL LIMIT 1",
        [siteId, key]
      )
    ).rows[0];
    if (def?.external_id) custom.push({ id: def.external_id, value });
  }

  return {
    id: row.id,
    email: row.email,
    ghl_id: row.ghl_id || "",
    tags: Array.isArray(row.tags) ? row.tags : [],
    status: row.status || "",
    notes: row.notes || "",
    profile: {
      name: cv.name ?? "",
      firstName: cv.firstName ?? "",
      lastName: cv.lastName ?? "",
      phone: cv.phone ?? "",
      companyName: cv.companyName ?? "",
      website: cv.website ?? "",
    },
    custom,
  };
}

async function loadOpportunityForPush(siteId, id) {
  const row = (
    await query(
      `SELECT o.*, p.external_id AS pipeline_ext_id
       FROM opportunities o
       LEFT JOIN pipelines p ON p.id = o.pipeline_id
       WHERE o.id = $1 AND o.site_id = $2`,
      [id, siteId]
    )
  ).rows[0];
  if (!row) return null;

  let pipelineStageExtId = "";
  if (row.pipeline_id && row.stage) {
    const st = (
      await query(
        "SELECT external_id FROM pipeline_stages WHERE pipeline_id = $1 AND key = $2 AND external_id IS NOT NULL LIMIT 1",
        [row.pipeline_id, row.stage]
      )
    ).rows[0];
    pipelineStageExtId = st?.external_id || "";
  }

  const contact =
    (
      await query(
        "SELECT id, ghl_id FROM contacts WHERE site_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
        [siteId, String(row.contact_email || "")]
      )
    ).rows[0] || null;

  let ownerExtId = "";
  if (row.owner_id) {
    const u = (
      await query("SELECT external_id FROM users WHERE id = $1 AND external_id IS NOT NULL LIMIT 1", [row.owner_id])
    ).rows[0];
    ownerExtId = u?.external_id || "";
  }

  return {
    id: row.id,
    ghl_id: row.ghl_id || "",
    name: row.title || "",
    monetaryValue: Number(row.amount) || 0,
    status: row.status || "open",
    pipelineId: row.pipeline_ext_id || "",
    pipelineStageId: pipelineStageExtId,
    contactGhlId: contact?.ghl_id || "",
    assignedTo: ownerExtId,
    notes: row.notes || "",
  };
}

async function sendContact(client, payload) {
  const contactBody = {
    email: payload.email,
    tags: payload.tags,
    customFields: payload.custom,
    ...(payload.profile.firstName ? { firstName: payload.profile.firstName } : {}),
    ...(payload.profile.lastName ? { lastName: payload.profile.lastName } : {}),
    ...(payload.profile.phone ? { phone: payload.profile.phone } : {}),
    ...(payload.profile.companyName ? { companyName: payload.profile.companyName } : {}),
    ...(payload.profile.website ? { website: payload.profile.website } : {}),
  };
  const data = await client.write("PUT", "/contacts/upsert", { contact: contactBody });
  const ghlId = data?.contact?.id || data?.id || "";
  return { ghlId };
}

async function sendOpportunity(client, payload) {
  const ghlId = payload.ghl_id || "";
  if (ghlId) {
    // UPDATE opportunità esistente in GHL.
    const body = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.monetaryValue !== undefined ? { monetaryValue: payload.monetaryValue } : {}),
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.pipelineStageId ? { pipelineStageId: payload.pipelineStageId } : {}),
      ...(payload.assignedTo ? { assignedTo: payload.assignedTo } : {}),
    };
    await client.write("PUT", `/opportunities/${ghlId}`, body);
    return { ghlId };
  }
  // CREATE: GHL richiede l'id GHL del contatto.
  if (!payload.contactGhlId) {
    throw new Error("Impossibile creare opportunità su GHL: contatto non ancora sincronizzato (manca contactId GHL)");
  }
  const body = {
    contactId: payload.contactGhlId,
    ...(payload.pipelineId ? { pipelineId: payload.pipelineId } : {}),
    ...(payload.pipelineStageId ? { pipelineStageId: payload.pipelineStageId } : {}),
    name: payload.name,
    monetaryValue: payload.monetaryValue,
    status: payload.status || "open",
    ...(payload.assignedTo ? { assignedTo: payload.assignedTo } : {}),
  };
  const data = await client.write("POST", "/opportunities", body);
  const createdId = data?.opportunity?.id || data?.id || "";
  return { ghlId: createdId };
}

async function sendDelete(client, entityType, externalId) {
  if (!externalId) return { skipped: true };
  await client.write("DELETE", `/${entityType === "contact" ? "contacts" : "opportunities"}/${externalId}`);
  return {};
}

// ── Processor ────────────────────────────────────────────────────────────

export async function processPushQueue({ siteId = null, limit = 20 } = {}) {
  const sites = siteId
    ? [siteId]
    : (await query(
        `SELECT q.site_id FROM source_push_queue q
         JOIN source_sync_config c ON c.site_id = q.site_id
         WHERE q.status = 'pending' AND q.next_attempt_at <= NOW()
           AND c.push_enabled = true AND c.push_direction <> 'in'
         GROUP BY q.site_id LIMIT 10`
      )).rows.map((r) => r.site_id);

  const summary = { processed: 0, sent: 0, failed: 0, skipped: 0, sites: sites.length };
  for (const sid of sites) {
    const lockClient = await getClient();
    let locked = false;
    try {
      const lockKey = PUSH_LOCK_KEY_BASE + (parseInt(sid, 10) || 0);
      const lr = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
      if (!lr.rows[0].locked) { summary.skipped++; continue; }
      locked = true;

      const cfg = await loadConfig(sid);
      if (!cfg || !cfg.push_enabled || cfg.push_direction === "in") { summary.skipped++; continue; }

      // Guardia: niente import in corso + replica al passo.
      if (!(await noImportRunning(sid))) { summary.skipped++; continue; }
      if (!(await replicaCaughtUp())) { summary.skipped++; continue; }

      // Claim atomico.
      let rows = [];
      try {
        await lockClient.query("BEGIN");
        const claim = await lockClient.query(
          `WITH due AS (
             SELECT q.id FROM source_push_queue q
             WHERE q.site_id = $1 AND q.status = 'pending' AND q.next_attempt_at <= NOW()
             ORDER BY q.created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
           )
           UPDATE source_push_queue q SET status = 'sending'
           FROM due WHERE q.id = due.id
           RETURNING q.id, q.entity_type, q.entity_id, q.external_id, q.operation, q.origin, q.attempts`,
          [sid, Math.min(parseInt(limit, 10) || 20, 100)]
        );
        rows = claim.rows;
        await lockClient.query("COMMIT");
      } catch (err) {
        await lockClient.query("ROLLBACK").catch(() => {});
        throw err;
      }

      if (rows.length === 0) { summary.skipped++; continue; }
      const client = cfg.token ? createSourceClient(cfg) : null;
      if (!client) {
        // Token non presente: lascia le righe pending (saranno riprese quando
        // la config verrà completata) e riportale a pending.
        await query(
          `UPDATE source_push_queue SET status = 'pending' WHERE site_id = $1 AND status = 'sending'`,
          [sid]
        );
        summary.skipped++;
        continue;
      }

      for (const row of rows) {
        summary.processed++;
        try {
          let ghlId = row.external_id || "";
          // Per delete, risolvi l'id GHL anche dall'entità se la coda non lo ha.
          if (row.operation === "delete" || !ghlId) {
            const entity = row.entity_type === "contact"
              ? (await query("SELECT ghl_id FROM contacts WHERE id=$1 AND site_id=$2", [row.entity_id, sid])).rows[0]
              : (await query("SELECT ghl_id FROM opportunities WHERE id=$1 AND site_id=$2", [row.entity_id, sid])).rows[0];
            ghlId = (entity?.ghl_id || row.external_id || "") || "";
          }

          if (row.operation === "delete") {
            await sendDelete(client, row.entity_type, ghlId);
            await query(
              `UPDATE source_push_queue SET status = 'sent', external_id = $2, attempts = attempts + 1,
                 last_error = '', next_attempt_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [row.id, ghlId]
            );
            summary.sent++;
            continue;
          }

          if (row.entity_type === "contact") {
            const payload = await loadContactForPush(sid, row.entity_id);
            if (!payload) throw new Error("Contatto locale non trovato");
            const res = await sendContact(client, payload);
            ghlId = res.ghlId || ghlId;
            if (ghlId) {
              await query(
                `UPDATE contacts SET ghl_id = $1, updated_at = NOW()
                 WHERE id = $2 AND site_id = $3`,
                [ghlId, row.entity_id, sid]
              ).catch(() => {});
            }
          } else if (row.entity_type === "opportunity") {
            const payload = await loadOpportunityForPush(sid, row.entity_id);
            if (!payload) throw new Error("Opportunità locale non trovata");
            const res = await sendOpportunity(client, payload);
            ghlId = res.ghlId || ghlId;
            if (ghlId) {
              await query(
                `UPDATE opportunities SET ghl_id = $1, updated_at = NOW()
                 WHERE id = $2 AND site_id = $3`,
                [ghlId, row.entity_id, sid]
              ).catch(() => {});
            }
          } else {
            throw new Error(`entity_type non supportato: ${row.entity_type}`);
          }

          await query(
            `UPDATE source_push_queue SET status = 'sent', external_id = $2, attempts = attempts + 1,
               last_error = '', next_attempt_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [row.id, ghlId]
          );
          summary.sent++;
        } catch (err) {
          const attempts = (row.attempts || 0) + 1;
          const lastError = String(err.message || err || "errore").slice(0, 500);
          if (attempts >= PUSH_MAX_ATTEMPTS) {
            await query(
              `UPDATE source_push_queue SET status = 'failed', attempts = $1, last_error = $2, updated_at = NOW() WHERE id = $3`,
              [attempts, lastError, row.id]
            );
          } else {
            const minutes = Math.pow(2, attempts);
            await query(
              `UPDATE source_push_queue SET status = 'pending', attempts = $1, last_error = $2,
                 next_attempt_at = NOW() + make_interval(mins => $3), updated_at = NOW()
               WHERE id = $4`,
              [attempts, lastError, minutes, row.id]
            );
          }
          summary.failed++;
        }
      }
    } finally {
      if (locked) {
        try {
          const lockKey = PUSH_LOCK_KEY_BASE + (parseInt(sid, 10) || 0);
          await lockClient.query("SELECT pg_advisory_unlock($1)", [lockKey]);
        } catch (err) {
          logger.error(`ghl-push: unlock fallito (site ${sid}): ${err.message}`);
        }
      }
      lockClient.release();
    }
  }
  return summary;
}

// ── Cron dallo scheduler: siti con push abilitato e coda dovuta ─────────
const activeSites = new Set();

export async function runGhlPushDue() {
  const due = (
    await query(
      `SELECT q.site_id
         FROM source_push_queue q
         JOIN source_sync_config c ON c.site_id = q.site_id
        WHERE q.status = 'pending' AND q.next_attempt_at <= NOW()
          AND c.push_enabled = true AND c.push_direction <> 'in'
        GROUP BY q.site_id
        LIMIT 5`
    )
  ).rows;

  let started = 0;
  for (const row of due) {
    const siteId = row.site_id;
    if (activeSites.has(siteId)) continue;
    activeSites.add(siteId);
    started++;
    processPushQueue({ siteId })
      .catch((err) => logger.error(`ghl-push cron site ${siteId}: ${err.message}`))
      .finally(() => activeSites.delete(siteId));
  }
  return { started };
}

// Utile per i test: chiave di lock stabile e prevedibile.
export function lockKeyForSite(siteId) {
  return PUSH_LOCK_KEY_BASE + (parseInt(siteId, 10) || 0);
}