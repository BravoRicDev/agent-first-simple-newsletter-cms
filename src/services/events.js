import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Eventi contatto — punto di ingresso centrale per ogni azione significativa.
//
//   emitContactEvent(siteId, email, "form_submitted", { form_slug })
//
// 1. INSERT in contact_events (storico/timeline/GDPR)
// 2. consumatori in parallelo (workflow immediati, scoring, segmenti)
//
// MAI bloccare il chiamante: ogni consumatore è dentro try/catch e
// Promise.allSettled. Un errore di workflow/scoring non deve mai far
// fallire un submit pubblico.
//
// I consumatori (services/workflows.js, scoring.js, segments.js) NON
// importano questo modulo staticamente per evitare cicli: quando un'azione
// genera a sua volta un evento (es. add_tag → tag_added) chiama
// emitContactEvent con import dinamico o accetta una callback.
// ─────────────────────────────────────────────────────────────────────────

const MAX_WORKFLOW_DEPTH = 3;

export async function emitContactEvent(siteId, email, eventType, payload = {}, { depth = 0 } = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !siteId) return;

  // Guard ricorsione: azioni di un workflow che generano eventi che
  // ri-triggerano workflow (A→B→A) si fermano dopo MAX_WORKFLOW_DEPTH.
  if (depth > MAX_WORKFLOW_DEPTH) {
    logger.warn(`emitContactEvent: profondità massima superata (${eventType}, ${email}, site ${siteId})`);
    return;
  }

  try {
    await query(
      `INSERT INTO contact_events (site_id, email, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [siteId, normalized, eventType, JSON.stringify(payload || {})]
    );
  } catch (err) {
    logger.error(`contact_events insert fallito (site=${siteId}, ${eventType}): ${err.message}`);
  }

  // Consumatori in parallelo; ognuno isolato.
  const consumers = [];

  // Workflow immediati (quelli con wait_days vanno in coda differita).
  consumers.push(
    import("./workflows.js")
      .then((m) => m.applyWorkflows(siteId, normalized, eventType, payload || {}, { depth }))
      .catch((err) => logger.error(`Workflow engine fallito (site=${siteId}, ${eventType}): ${err.message}`))
  );

  // Scoring: regole evento→punti + soglie.
  consumers.push(
    import("./scoring.js")
      .then((m) => m.applyScoring(siteId, normalized, eventType, payload || {}, { depth }))
      .catch((err) => logger.error(`Scoring fallito (site=${siteId}, ${eventType}): ${err.message}`))
  );

  // Segmenti: membership materializzata, aggiornata incrementalmente.
  consumers.push(
    import("./segments.js")
      .then((m) => m.refreshSegmentsForContact(siteId, normalized, { source: "event" }))
      .catch((err) => logger.error(`Segment refresh fallito (site=${siteId}, ${eventType}): ${err.message}`))
  );

  // Webhook OUT (feature 35): inoltro dell'evento a URL esterni (es. n8n)
  // tramite coda webhook_deliveries. Fire-and-forget con try/catch esplicito:
  // un errore di enqueue non deve MAI bloccare o crashare il flusso eventi.
  consumers.push(
    (async () => {
      try {
        const { enqueueForEvent } = await import("./webhooks.js");
        await enqueueForEvent(siteId, eventType, payload || {});
      } catch (err) {
        logger.error(`Webhook out enqueue fallito (site=${siteId}, ${eventType}): ${err.message}`);
      }
    })()
  );

  // Agent runtime event triggers (ONDA 2 Phase 6): avvia conversazioni
  // automatiche su eventi CRM (booking_created, contact_created, ecc.)
  consumers.push(
    (async () => {
      try {
        const { triggerRuntimeForEvent } = await import("./agent-runtime.js");
        await triggerRuntimeForEvent({
          siteId,
          eventType,
          contactEmail: normalized,
          payload: payload || {},
        });
      } catch (err) {
        logger.error(`Agent runtime event trigger fallito (site=${siteId}, ${eventType}): ${err.message}`);
      }
    })()
  );

  await Promise.allSettled(consumers);
}

// Versione "fire and forget" per chi non vuole aspettare (ma di norma
// emitContactEvent è già veloce; questa è per hot path come tracking).
export function emitContactEventAsync(siteId, email, eventType, payload = {}, opts = {}) {
  emitContactEvent(siteId, email, eventType, payload, opts).catch((err) => {
    logger.error(`emitContactEventAsync fallito: ${err.message}`);
  });
}

// Ottiene gli ultimi eventi di un contatto (per timeline, GDPR export).
export async function getContactEvents(siteId, email, { limit = 50, types = null } = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return [];
  const params = [siteId, normalized];
  let where = "site_id = $1 AND email = $2";
  if (Array.isArray(types) && types.length > 0) {
    const ph = types.map((_, i) => `$${params.length + i + 1}`).join(",");
    where += ` AND event_type IN (${ph})`;
    params.push(...types);
  }
  params.push(Math.min(parseInt(limit, 10) || 50, 500));
  const rows = (await query(
    `SELECT id, event_type, payload, created_at FROM contact_events
     WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  )).rows;
  return rows;
}

// Registra l'evento per un contatto che non esiste ancora in contacts
// (upsert silenzioso) — usato dal tracking email dove l'email può non
// essere mai passata da un form.
export async function ensureContactAndEmit(siteId, email, eventType, payload = {}, opts = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !siteId) return;
  try {
    await query(
      `INSERT INTO contacts (site_id, email) VALUES ($1, $2)
       ON CONFLICT (site_id, email) DO NOTHING`,
      [siteId, normalized]
    );
  } catch (err) {
    logger.error(`ensureContact upsert fallito (site=${siteId}): ${err.message}`);
  }
  await emitContactEvent(siteId, normalized, eventType, payload, opts);
}
