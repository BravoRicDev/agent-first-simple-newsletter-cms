import { query } from "../db.js";
import { sendEmail } from "./email.js";
import { auditLog } from "./audit.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 44 — Quote/rate-limit per canale con avvisi.
//
// Un limite (channel_limits) definisce per sito+canale+periodo il numero
// massimo di messaggi consentiti ('email'|'whatsapp'|'call'|'sms'|'chat'
// × 'hour'|'day'). Il contatore (channel_usage) è una riga per periodo
// con period_start = inizio dell'ora/giorno corrente: checkLimit() lo
// legge senza modificarlo, consume() lo incrementa atomicamente con
// INSERT ... ON CONFLICT ... DO UPDATE.
//
// SCELTA DI DESIGN: se NON esiste un limite attivo per (canale, periodo),
// sia checkLimit() che consume() rispondono allowed:true e NON creano
// alcuna riga in channel_usage (consume ritorna usage:0). Così i canali
// senza quota non producono scritture di contabilità inutili; appena viene
// creato un limite il contatore riparte da zero nel periodo corrente.
//
// Avviso email: al primo superamento del limite, se notify_email è
// valorizzata e il flag notified del periodo è ancora false, viene
// inviato sendEmail() (in try/catch: SMTP assente/errore non deve mai
// far crashare il consume), registrato un auditLog
// (entity_type 'channel_limit', action 'limit_exceeded') e il flag
// notified viene alzato — un solo avviso per periodo anche se il
// superamento prosegue.
// ─────────────────────────────────────────────────────────────────────────

const CHANNELS = new Set(["email", "whatsapp", "call", "sms", "chat"]);
const PERIODS = new Set(["hour", "day"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

function sanitizeChannel(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!CHANNELS.has(value)) {
    throw validationError("Canale non valido: usare 'email', 'whatsapp', 'call', 'sms' o 'chat'");
  }
  return value;
}

function sanitizePeriod(raw, fallback = "hour") {
  const value = String(raw ?? fallback).trim().toLowerCase();
  if (!PERIODS.has(value)) {
    throw validationError("Periodo non valido: usare 'hour' o 'day'");
  }
  return value;
}

function sanitizeMaxCount(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000000) {
    throw validationError("max_count deve essere un intero tra 1 e 1000000");
  }
  return n;
}

function sanitizeNotifyEmail(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "") return "";
  if (!EMAIL_RE.test(value)) {
    throw validationError("notify_email non è un indirizzo email valido");
  }
  return value.slice(0, 255);
}

// Espressione SQL che calcola l'inizio del periodo corrente (fuso del DB).
function periodStartExpr(period) {
  return period === "day" ? "date_trunc('day', NOW())" : "date_trunc('hour', NOW())";
}

async function findActiveLimit(siteId, channel, period) {
  const result = await query(
    "SELECT * FROM channel_limits WHERE site_id = $1 AND channel = $2 AND period = $3 AND active = true",
    [siteId, channel, period]
  );
  return result.rows[0] || null;
}

// ── CRUD limiti ──────────────────────────────────────────────────────────

export async function listLimits(siteId) {
  const result = await query(
    "SELECT * FROM channel_limits WHERE site_id = $1 ORDER BY channel, period",
    [siteId]
  );
  return result.rows;
}

export async function createLimit(siteId, data = {}) {
  const channel = sanitizeChannel(data.channel);
  const period = sanitizePeriod(data.period);
  const maxCount = sanitizeMaxCount(data.max_count === undefined ? 100 : data.max_count);
  const notifyEmail = sanitizeNotifyEmail(data.notify_email);
  const active = data.active === undefined ? true : !!data.active;
  try {
    const result = await query(
      `INSERT INTO channel_limits (site_id, channel, period, max_count, notify_email, active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [siteId, channel, period, maxCount, notifyEmail, active]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === "23505") {
      throw conflictError(`Limite già esistente per il canale '${channel}' (periodo '${period}')`);
    }
    throw err;
  }
}

export async function updateLimit(siteId, id, data = {}) {
  const limitId = parseInt(id, 10);
  if (!Number.isInteger(limitId) || limitId < 1) return null;
  const current = (await query(
    "SELECT * FROM channel_limits WHERE id = $1 AND site_id = $2",
    [limitId, siteId]
  )).rows[0];
  if (!current) return null;

  const fields = {};
  if (data.channel !== undefined) fields.channel = sanitizeChannel(data.channel);
  if (data.period !== undefined) fields.period = sanitizePeriod(data.period, current.period);
  if (data.max_count !== undefined) fields.max_count = sanitizeMaxCount(data.max_count);
  if (data.notify_email !== undefined) fields.notify_email = sanitizeNotifyEmail(data.notify_email);
  if (data.active !== undefined) fields.active = !!data.active;

  if (Object.keys(fields).length === 0) return current;

  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const values = [...keys.map((k) => fields[k]), limitId, siteId];
  try {
    const result = await query(
      `UPDATE channel_limits SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND site_id = $${values.length}
       RETURNING *`,
      values
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err.code === "23505") {
      throw conflictError(
        `Limite già esistente per il canale '${fields.channel ?? current.channel}' (periodo '${fields.period ?? current.period}')`
      );
    }
    throw err;
  }
}

export async function deleteLimit(siteId, id) {
  const limitId = parseInt(id, 10);
  if (!Number.isInteger(limitId) || limitId < 1) return null;
  const result = await query(
    "DELETE FROM channel_limits WHERE id = $1 AND site_id = $2 RETURNING id",
    [limitId, siteId]
  );
  return result.rows[0] ? limitId : null;
}

// ── Verifica e consumo ───────────────────────────────────────────────────

// Upsert che ritorna la riga di usage del periodo corrente SENZA
// incrementare il contatore (DO UPDATE no-op su period_start).
async function ensureUsageRow(siteId, channel, period, periodStart) {
  const result = await query(
    `INSERT INTO channel_usage (site_id, channel, period, period_start, count)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (site_id, channel, period, period_start)
     DO UPDATE SET period_start = EXCLUDED.period_start
     RETURNING count, notified`,
    [siteId, channel, period, periodStart]
  );
  return result.rows[0];
}

export async function checkLimit(siteId, channel, { period = "hour" } = {}) {
  const ch = sanitizeChannel(channel);
  const per = sanitizePeriod(period);
  const limit = await findActiveLimit(siteId, ch, per);
  if (!limit) {
    return { allowed: true, usage: 0, limit: null, remaining: null, period_start: null };
  }
  const psResult = await query(`SELECT ${periodStartExpr(per)} AS start`, []);
  const periodStart = psResult.rows[0].start;
  const row = await ensureUsageRow(siteId, ch, per, periodStart);
  return {
    allowed: row.count < limit.max_count,
    usage: row.count,
    limit: limit.max_count,
    remaining: Math.max(0, limit.max_count - row.count),
    period_start: periodStart,
  };
}

export async function consume(siteId, channel, { period = "hour" } = {}) {
  const ch = sanitizeChannel(channel);
  const per = sanitizePeriod(period);
  const limit = await findActiveLimit(siteId, ch, per);
  // Nessun limite attivo → consumo sempre permesso, nessuna riga usage
  // creata (vedi SCELTA DI DESIGN in testa al file).
  if (!limit) {
    return { allowed: true, usage: 0, limit: null, exceeded: false };
  }
  const psResult = await query(`SELECT ${periodStartExpr(per)} AS start`, []);
  const periodStart = psResult.rows[0].start;
  const result = await query(
    `INSERT INTO channel_usage (site_id, channel, period, period_start, count)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (site_id, channel, period, period_start)
     DO UPDATE SET count = channel_usage.count + 1
     RETURNING count, notified`,
    [siteId, ch, per, periodStart]
  );
  const row = result.rows[0];
  const count = row.count;
  const exceeded = count > limit.max_count;

  if (exceeded && limit.notify_email && !row.notified) {
    await notifyExceeded({
      siteId,
      channel: ch,
      period: per,
      maxCount: limit.max_count,
      notifyEmail: limit.notify_email,
      count,
      periodStart,
    });
  }

  return { allowed: count <= limit.max_count, usage: count, limit: limit.max_count, exceeded };
}

// Invio avviso email (mai crash: SMTP assente o errore → solo log),
// auditLog 'channel_limit_exceeded' e flag notified = true per il periodo.
async function notifyExceeded({ siteId, channel, period, maxCount, notifyEmail, count, periodStart }) {
  const subject = "Limite canale superato";
  const body = `Il canale ${channel} ha superato il limite di ${maxCount} messaggi per ${period}.`;
  try {
    await sendEmail(notifyEmail, subject, body);
  } catch (err) {
    logger.error("channel limit notify email failed", {
      error: err.message, siteId, channel, period,
    });
  }
  await auditLog({
    siteId,
    entityType: "channel_limit",
    entityId: null,
    action: "limit_exceeded",
    newData: { channel, period, maxCount, count },
  });
  await query(
    "UPDATE channel_usage SET notified = true WHERE site_id = $1 AND channel = $2 AND period = $3 AND period_start = $4",
    [siteId, channel, period, periodStart]
  );
}

// ── Storico e manutenzione ───────────────────────────────────────────────

export async function getUsage(siteId, channel, { period = "hour", limit = 30 } = {}) {
  const ch = sanitizeChannel(channel);
  const per = sanitizePeriod(period);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  // Solo periodi recenti: ultime 24 ore per 'hour', ultimi 30 giorni per 'day'.
  const cutoff = per === "day" ? "NOW() - INTERVAL '30 days'" : "NOW() - INTERVAL '24 hours'";
  const result = await query(
    `SELECT period_start, count, notified
     FROM channel_usage
     WHERE site_id = $1 AND channel = $2 AND period = $3 AND period_start >= ${cutoff}
     ORDER BY period_start DESC
     LIMIT $4`,
    [siteId, ch, per, lim]
  );
  return result.rows;
}

// Azzera il contatore del periodo corrente (DELETE) — uso test/manutenzione.
export async function resetUsage(siteId, channel, { period = "hour" } = {}) {
  const ch = sanitizeChannel(channel);
  const per = sanitizePeriod(period);
  const psResult = await query(`SELECT ${periodStartExpr(per)} AS start`, []);
  const periodStart = psResult.rows[0].start;
  const result = await query(
    "DELETE FROM channel_usage WHERE site_id = $1 AND channel = $2 AND period = $3 AND period_start = $4",
    [siteId, ch, per, periodStart]
  );
  return { reset: result.rowCount, period_start: periodStart };
}
