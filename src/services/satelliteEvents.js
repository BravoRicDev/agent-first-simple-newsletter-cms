import { query } from "../db.js";
import { findEnabledSatelliteByName } from "./satellites.js";

// ─────────────────────────────────────────────────────────────────────────
// Eventi asincroni tra satelliti (F2) — inbox/outbox nelle tabelle del CMS.
//
//   publishEvent({ source, type, target, payload, dedupeKey })
//     → INSERT con dedupe (ON CONFLICT DO NOTHING): ritorna l'evento o
//       null se duplicato (idempotenza del publisher).
//   inboxEvents({ target }) → solo eventi per quel satellite o broadcast '*'
//   ackEvent({ target, id }) → conferma idempotente del ricevente
//   markDelivered(id) → stub per il push webhook futuro (F2.4 differito)
//
// Il perimetro NON è scelto dal chiamante: le route risolvono il nome
// satellite dall'utente proprietario del token (sso_satellites.user_id)
// e passano quello qui — un satellite non vede mai gli eventi altrui.
// ─────────────────────────────────────────────────────────────────────────

export class EventError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function publishEvent({ source, type, target = "*", payload = {}, dedupeKey = null }) {
  const src = String(source || "").trim().slice(0, 100);
  const evtType = String(type || "").trim().slice(0, 200);
  if (!src) throw new EventError(400, "source_required");
  if (!evtType) throw new EventError(400, "type_required");

  const tgt = target === undefined || target === null || target === "" ? "*" : String(target).trim().slice(0, 100);
  if (tgt !== "*") {
    // Il destinatario deve essere un satellite registrato e attivo.
    const exists = await findEnabledSatelliteByName(tgt);
    if (!exists) throw new EventError(404, "satellite_not_found");
  }

  let payloadJson;
  try {
    payloadJson = JSON.stringify(payload ?? {});
  } catch {
    throw new EventError(400, "invalid_payload");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new EventError(400, "invalid_payload");
  }

  const key = dedupeKey === undefined || dedupeKey === null || dedupeKey === ""
    ? null : String(dedupeKey).slice(0, 300);

  const result = await query(
    `INSERT INTO satellite_events (type, source, target, payload, dedupe_key)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (source, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [evtType, src, tgt, payloadJson, key]
  );
  return result.rows[0] || null; // null = duplicato (stesso source+dedupeKey)
}

export async function inboxEvents({ target, limit = 50 }) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return (await query(
    `SELECT * FROM satellite_events
     WHERE status = 'pending' AND target IN ($1, '*')
     ORDER BY created_at ASC
     LIMIT ${lim}`,
    [String(target)]
  )).rows;
}

export async function getEventVisibleTo(target, id) {
  const rows = (await query(
    `SELECT * FROM satellite_events WHERE id = $1 AND (target = $2 OR target = '*')`,
    [parseInt(id, 10), String(target)]
  )).rows;
  return rows[0] || null;
}

export async function ackEvent({ target, id }) {
  const result = await query(
    `UPDATE satellite_events SET status = 'acked', acked_at = NOW()
     WHERE id = $1 AND (target = $2 OR target = '*') AND status <> 'acked'
     RETURNING *`,
    [parseInt(id, 10), String(target)]
  );
  return result.rows[0] || null;
}

// Stub per il push webhook futuro: chiamato dal poller F2.4 quando verrà
// attivato. Aggiorna solo i contatori di consegna.
export async function markDelivered(id, { error = null } = {}) {
  const result = await query(
    `UPDATE satellite_events
     SET status = CASE WHEN $2::text IS NULL THEN 'delivered' ELSE 'failed' END,
         delivered_at = CASE WHEN $2::text IS NULL THEN NOW() ELSE delivered_at END,
         attempts = attempts + 1,
         last_error = $2::text
     WHERE id = $1 RETURNING *`,
    [parseInt(id, 10), error]
  );
  return result.rows[0] || null;
}
