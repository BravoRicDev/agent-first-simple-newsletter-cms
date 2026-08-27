import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 37 — Sync calendario bidirezionale (chiamate ↔ Google Calendar).
//
// Una config per sito (calendar_sync_configs) collega le chiamate della
// tabella calls a un calendario Google tramite la connessione OAuth della
// feature 36 (tabella oauth_connections, creata dal collega). Ogni
// esecuzione di syncNow() registra una riga in calendar_sync_log.
//
// Fallimento pulito senza OAuth: se la connessione manca (o la tabella
// oauth_connections non esiste ancora perché la migrazione 055 non è stata
// applicata), syncNow() NON tocca Google: registra un log con status
// 'error' e ritorna { error: 'OAuth non configurato: ...' }. Nessuna
// chiamata HTTP parte mai senza access_token.
// ─────────────────────────────────────────────────────────────────────────

const DIRECTIONS = new Set(["both", "in", "out"]);
const CALL_STATUSES = new Set(["programmata", "completata", "no_show", "annullata"]);
const GOOGLE_API_BASE = "https://www.googleapis.com/calendar/v3";
const HTTP_TIMEOUT_MS = 15000;
const PUSH_DURATION_MINUTES = 30;
const PULL_MATCH_WINDOW_MS = 2 * 60000;

// NOTA: calls.status usa i valori italiani del CHECK di 029_calls.sql
// ('programmata','completata','no_show','annullata'). Lo spec diceva
// 'scheduled', ma quel valore violerebbe il CHECK: il pull crea le call con
// 'programmata' (equivalente semantico), sovrascrivibile via mapping
// event_to_call_status con uno dei valori ammessi.
const DEFAULT_PULL_CALL_STATUS = "programmata";

// ── Sanitizzazione ───────────────────────────────────────────────────────

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function sanitizeDirection(raw, fallback = "both") {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!DIRECTIONS.has(value)) {
    throw validationError("Direzione non valida: usare 'both', 'in' o 'out'");
  }
  return value;
}

function sanitizeCalendarId(raw) {
  if (raw === undefined || raw === null) return "primary";
  const value = String(raw).trim();
  return (value || "primary").slice(0, 255);
}

function sanitizeMapping(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key === "string" && key.length <= 100) clean[key] = value;
  }
  return clean;
}

function sanitizeOauthConnectionId(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sanitizePullStatus(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return CALL_STATUSES.has(value) ? value : DEFAULT_PULL_CALL_STATUS;
}

// ── CRUD config ──────────────────────────────────────────────────────────

export async function listConfigs(siteId) {
  return (await query(
    "SELECT * FROM calendar_sync_configs WHERE site_id = $1 ORDER BY id",
    [siteId]
  )).rows;
}

export async function getConfig(siteId, id) {
  const row = (await query(
    "SELECT * FROM calendar_sync_configs WHERE site_id = $1 AND id = $2",
    [siteId, id]
  )).rows[0];
  return row || null;
}

export async function createConfig(siteId, data = {}) {
  const direction = sanitizeDirection(data.direction);
  const calendarId = sanitizeCalendarId(data.calendar_id);
  const mapping = sanitizeMapping(data.mapping);
  const oauthConnectionId = sanitizeOauthConnectionId(data.oauth_connection_id);
  const active = data.active === undefined ? true : !!data.active;
  const result = await query(
    `INSERT INTO calendar_sync_configs
       (site_id, oauth_connection_id, calendar_id, direction, mapping, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [siteId, oauthConnectionId, calendarId, direction, JSON.stringify(mapping), active]
  );
  return result.rows[0];
}

export async function updateConfig(siteId, id, data = {}) {
  const current = await getConfig(siteId, id);
  if (!current) return null;
  const direction = data.direction !== undefined
    ? sanitizeDirection(data.direction) : current.direction;
  const calendarId = data.calendar_id !== undefined
    ? sanitizeCalendarId(data.calendar_id) : current.calendar_id;
  const mapping = data.mapping !== undefined
    ? sanitizeMapping(data.mapping) : (current.mapping || {});
  const oauthConnectionId = data.oauth_connection_id !== undefined
    ? sanitizeOauthConnectionId(data.oauth_connection_id) : current.oauth_connection_id;
  const active = data.active !== undefined ? !!data.active : current.active;
  const result = await query(
    `UPDATE calendar_sync_configs
        SET oauth_connection_id = $1, calendar_id = $2, direction = $3,
            mapping = $4, active = $5, updated_at = NOW()
      WHERE site_id = $6 AND id = $7 RETURNING *`,
    [oauthConnectionId, calendarId, direction, JSON.stringify(mapping), active, siteId, id]
  );
  return result.rows[0] || null;
}

export async function deleteConfig(siteId, id) {
  const result = await query(
    "DELETE FROM calendar_sync_configs WHERE site_id = $1 AND id = $2 RETURNING id",
    [siteId, id]
  );
  return result.rows[0] || null;
}

// ── Log ──────────────────────────────────────────────────────────────────

export async function listLogs(siteId, configId, { limit = 50 } = {}) {
  const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  return (await query(
    `SELECT * FROM calendar_sync_log
      WHERE site_id = $1 AND config_id = $2
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [siteId, configId, l]
  )).rows;
}

async function writeLog({ siteId, configId, direction = null, kind = null, count = 0, status = "ok", error = "" }) {
  try {
    await query(
      `INSERT INTO calendar_sync_log (site_id, config_id, direction, kind, count, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [siteId, configId, direction, kind, count, status, String(error || "").slice(0, 2000)]
    );
  } catch (err) {
    // Il log non deve MAI far fallire il sync: si logga l'errore e si prosegue.
    logger.error(`Calendar sync: log non scritto (config=${configId}): ${err.message}`);
  }
}

// ── OAuth ────────────────────────────────────────────────────────────────

async function loadOAuthConnection(connectionId) {
  if (!connectionId) return null;
  try {
    const row = (await query(
      `SELECT id, access_token, refresh_token, provider, account_email, token_expires_at
       FROM oauth_connections
       WHERE id = $1 AND active = true AND access_token <> ''`,
      [connectionId]
    )).rows[0];
    return row || null;
  } catch (err) {
    // 42P01 = undefined_table: la migrazione 055 (feature 36) non è ancora
    // stata applicata → nessuna connessione possibile, fallimento pulito.
    if (err.code === "42P01") {
      logger.warn("Calendar sync: tabella oauth_connections non presente (feature 36 non applicata)");
      return null;
    }
    logger.error(`Calendar sync: lettura connessione OAuth fallita (id=${connectionId}): ${err.message}`);
    return null;
  }
}

// ── HTTP verso Google (sempre in try/catch, timeout 15s) ─────────────────

async function googleFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err) {
  return err?.name === "AbortError" ? `timeout dopo ${HTTP_TIMEOUT_MS / 1000}s` : (err?.message || String(err));
}

// ── Direzione out: calls → eventi Google Calendar ────────────────────────

async function pushCallsToCalendar(siteId, config, conn) {
  const calendarId = encodeURIComponent(config.calendar_id || "primary");
  const url = `${GOOGLE_API_BASE}/calendars/${calendarId}/events`;
  const headers = {
    Authorization: `Bearer ${conn.access_token}`,
    "Content-Type": "application/json",
  };

  let calls;
  try {
    calls = (await query(
      `SELECT id, email, scheduled_at, status, outcome_notes AS notes
       FROM calls WHERE site_id = $1 AND scheduled_at IS NOT NULL`,
      [siteId]
    )).rows;
  } catch (err) {
    await writeLog({
      siteId, configId: config.id, direction: "out", kind: "push",
      count: 0, status: "error", error: `Lettura calls fallita: ${err.message}`,
    });
    return { pushed: 0, errors: 1 };
  }

  let pushed = 0;
  const errors = [];
  for (const call of calls) {
    try {
      const start = new Date(call.scheduled_at);
      if (Number.isNaN(start.getTime())) continue;
      const end = new Date(start.getTime() + PUSH_DURATION_MINUTES * 60000);
      const body = {
        summary: `Chiamata con ${call.email}`,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        description: call.notes || "",
      };
      const res = await googleFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        errors.push(`call #${call.id}: HTTP ${res.status} ${String(text).slice(0, 200)}`);
      } else {
        pushed++;
      }
    } catch (err) {
      // Un errore di rete su una chiamata NON blocca le altre.
      errors.push(`call #${call.id}: ${errorMessage(err)}`);
    }
  }

  await writeLog({
    siteId, configId: config.id, direction: "out", kind: "push", count: pushed,
    status: errors.length ? "error" : "ok",
    error: errors.length ? errors.slice(0, 5).join(" | ") : "",
  });
  return { pushed, errors: errors.length };
}

// ── Direzione in: eventi Google → calls ──────────────────────────────────

// Solo gli eventi con summary "Chiamata con <email>" entrano in calls: gli
// altri eventi del calendario vengono ignorati. Se esiste già una call con
// la stessa email nello stesso orario (±2 min) la si aggiorna invece di
// duplicarla.
async function upsertCallFromEvent(siteId, email, start, notes, status) {
  const existing = (await query(
    `SELECT id FROM calls
      WHERE site_id = $1 AND email = $2
        AND scheduled_at BETWEEN $3 AND $4`,
    [siteId, email,
      new Date(start.getTime() - PULL_MATCH_WINDOW_MS),
      new Date(start.getTime() + PULL_MATCH_WINDOW_MS)]
  )).rows[0];
  if (existing) {
    await query(
      "UPDATE calls SET status = $1, outcome_notes = $2, updated_at = NOW() WHERE id = $3",
      [status, notes, existing.id]
    );
  } else {
    await query(
      `INSERT INTO calls (site_id, email, name, scheduled_at, duration_minutes, status, outcome_notes)
       VALUES ($1, $2, '', $3, $4, $5, $6)`,
      [siteId, email, start, PUSH_DURATION_MINUTES, status, notes]
    );
  }
}

async function pullEventsToCalls(siteId, config, conn) {
  const calendarId = encodeURIComponent(config.calendar_id || "primary");
  const timeMin = new Date().toISOString();
  const url = `${GOOGLE_API_BASE}/calendars/${calendarId}/events`
    + `?timeMin=${encodeURIComponent(timeMin)}&singleEvents=true&orderBy=startTime&maxResults=250`;
  const headers = { Authorization: `Bearer ${conn.access_token}` };

  const mapping = (config.mapping && typeof config.mapping === "object") ? config.mapping : {};
  const pullStatus = sanitizePullStatus(mapping.event_to_call_status);

  let data;
  try {
    const res = await googleFetch(url, { method: "GET", headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = `GET events: HTTP ${res.status} ${String(text).slice(0, 200)}`;
      await writeLog({
        siteId, configId: config.id, direction: "in", kind: "pull",
        count: 0, status: "error", error: msg,
      });
      return { pulled: 0, errors: 1 };
    }
    data = await res.json();
  } catch (err) {
    const msg = `GET events: ${errorMessage(err)}`;
    await writeLog({
      siteId, configId: config.id, direction: "in", kind: "pull",
      count: 0, status: "error", error: msg,
    });
    return { pulled: 0, errors: 1 };
  }

  let pulled = 0;
  const errors = [];
  for (const event of (data.items || [])) {
    try {
      const match = /^Chiamata con\s+(.+)$/i.exec(String(event.summary || "").trim());
      if (!match) continue; // eventi non-CRM: ignorati
      const email = match[1].trim().toLowerCase();
      if (!email.includes("@")) continue;
      const startRaw = event.start?.dateTime || event.start?.date;
      const start = new Date(startRaw);
      if (Number.isNaN(start.getTime())) continue;
      const notes = String(event.description || "");
      await upsertCallFromEvent(siteId, email, start, notes, pullStatus);
      pulled++;
    } catch (err) {
      errors.push(`event ${event.id || "?"}: ${errorMessage(err)}`);
    }
  }

  await writeLog({
    siteId, configId: config.id, direction: "in", kind: "pull", count: pulled,
    status: errors.length ? "error" : "ok",
    error: errors.length ? errors.slice(0, 5).join(" | ") : "",
  });
  return { pulled, errors: errors.length };
}

// ── Sync ─────────────────────────────────────────────────────────────────

// Esegue la sincronizzazione secondo la direzione della config (o l'override
// esplicito direction). Senza connessione OAuth attiva NON parte nessuna
// chiamata verso Google: registra un log con status 'error' e ritorna
// { error: 'OAuth non configurato: ...' }.
export async function syncNow(siteId, configId, { direction: directionOverride } = {}) {
  const config = await getConfig(siteId, configId);
  if (!config) return { error: "Configurazione non trovata" };
  if (!config.active) return { error: "Configurazione disattivata" };

  const direction = directionOverride !== undefined && directionOverride !== null
    ? sanitizeDirection(directionOverride, config.direction)
    : config.direction;
  const kindForError = direction === "in" ? "pull" : "push";

  const conn = await loadOAuthConnection(config.oauth_connection_id);
  if (!conn) {
    const msg = "OAuth non configurato: collega prima un account Google (feature 36)";
    await writeLog({
      siteId, configId: config.id, direction, kind: kindForError,
      count: 0, status: "error", error: msg,
    });
    return { error: msg };
  }

  const results = {};
  if (direction === "out" || direction === "both") {
    results.push = await pushCallsToCalendar(siteId, config, conn);
  }
  if (direction === "in" || direction === "both") {
    results.pull = await pullEventsToCalls(siteId, config, conn);
  }

  await query(
    "UPDATE calendar_sync_configs SET last_sync_at = NOW(), updated_at = NOW() WHERE id = $1",
    [configId]
  ).catch(err => logger.error(`Calendar sync: aggiornamento last_sync_at fallito (config=${configId}): ${err.message}`));

  return { ok: true, direction, results };
}
