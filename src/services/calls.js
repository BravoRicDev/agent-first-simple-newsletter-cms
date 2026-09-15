import crypto from "crypto";
import { query, getClient } from "../db.js";
import { sendSiteEmail } from "./email.js";
import { renderEmail } from "./email-templates.js";
import { logger } from "./logger.js";
import { upsertContact } from "./contacts.js";
import { getCanonicalBaseUrl } from "./urls.js";

const DEFAULT_DAYS_AHEAD = 14;

// Nota volutamente semplice: gli orari di disponibilità sono interpretati
// nel fuso orario del processo Node (di norma UTC in un container Docker
// senza TZ impostata) — non c'è gestione multi-fuso per sito. Per
// un'installazione con TZ locale, va impostata la variabile d'ambiente TZ
// del container.

export async function getAvailabilityRules(siteId, calendarId = null) {
  // calendar_id NULL = regole legacy site-wide (usate da /book/:siteId senza
  // slug). Un calendario concreto usa le proprie regole; se non ne ha,
  // fallback alle regole site-wide (comportamento naturale di migrazione).
  if (calendarId) {
    const own = (await query(
      "SELECT id, weekday, start_time, end_time, slot_minutes FROM call_availability WHERE site_id = $1 AND calendar_id = $2 ORDER BY weekday, start_time",
      [siteId, calendarId]
    )).rows;
    if (own.length > 0) return own;
  }
  return (await query(
    "SELECT id, weekday, start_time, end_time, slot_minutes FROM call_availability WHERE site_id = $1 AND calendar_id IS NULL ORDER BY weekday, start_time",
    [siteId]
  )).rows;
}

// Sostituzione atomica di tutte le regole — stesso pattern già usato per gli
// step delle sequenze newsletter (PUT .../sequences/:id/steps): più semplice
// da ragionare che un CRUD riga-per-riga per un set piccolo come questo.
export async function setAvailabilityRules(siteId, rules, calendarId = null) {
  await query(
    "DELETE FROM call_availability WHERE site_id = $1 AND calendar_id IS NOT DISTINCT FROM $2",
    [siteId, calendarId]
  );
  for (const r of rules) {
    const weekday = parseInt(r.weekday, 10);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!/^\d{2}:\d{2}$/.test(r.start_time) || !/^\d{2}:\d{2}$/.test(r.end_time)) continue;
    // slot_minutes NON validato prima: un valore negativo salvato in DB
    // faceva girare computeAvailableSlots() in loop infinito (m += -5 non
    // avanza mai) → DoS dell'event loop su ogni richiesta pubblica di booking.
    const slotMinutes = parseInt(r.slot_minutes, 10);
    if (!Number.isInteger(slotMinutes) || slotMinutes <= 0 || slotMinutes > 480) continue;
    await query(
      "INSERT INTO call_availability (site_id, calendar_id, weekday, start_time, end_time, slot_minutes) VALUES ($1,$2,$3,$4,$5,$6)",
      [siteId, calendarId, weekday, r.start_time, r.end_time, slotMinutes]
    );
  }
}

// ── Calendari ──────────────────────────────────────────────────────────────
// Ogni calendario è una "agenda" prenotabile (es. "Consulenza", "Demo",
// "Assistenza") con la propria disponibilità settimanale, le proprie
// chiamate e un eventuale proprietario (users.id). Si integra nelle pagine
// con {{calendar:slug}} (espanso da page-renderer.js come {{form:slug}}).

function sanitizeCalendarSlug(raw) {
  return String(raw || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export async function listCalendars(siteId) {
  return (await query(
    `SELECT c.*, u.email AS owner_email
     FROM calendars c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.site_id = $1 ORDER BY c.name`,
    [siteId]
  )).rows;
}

export async function getCalendar(siteId, calendarId) {
  const row = (await query(
    "SELECT * FROM calendars WHERE site_id = $1 AND id = $2",
    [siteId, calendarId]
  )).rows[0];
  return row || null;
}

export async function getCalendarBySlug(siteId, slug) {
  const row = (await query(
    "SELECT * FROM calendars WHERE site_id = $1 AND slug = $2",
    [siteId, slug]
  )).rows[0];
  return row || null;
}

// Risolve il target di una prenotazione pubblica: slug esplicito → quel
// calendario; nessuno slug → il primo calendario attivo del sito, altrimenti
// null (regole site-wide legacy, comportamento preesistente di /book/:siteId).
export async function resolveBookingTarget(siteId, calendarSlug = null) {
  if (calendarSlug) return getCalendarBySlug(siteId, calendarSlug);
  const row = (await query(
    "SELECT * FROM calendars WHERE site_id = $1 AND enabled = true ORDER BY id LIMIT 1",
    [siteId]
  )).rows[0];
  return row || null;
}

export async function createCalendar(siteId, { name, slug, description = "", userId = null, enabled = true, tyPage = "" }) {
  const cleanSlug = sanitizeCalendarSlug(slug || name);
  const cleanName = String(name || "").trim().slice(0, 255);
  if (!cleanSlug || !cleanName) throw new Error("Nome e slug del calendario sono obbligatori.");
  try {
    const result = await query(
      `INSERT INTO calendars (site_id, slug, name, description, user_id, enabled, ty_page)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [siteId, cleanSlug, cleanName, String(description || "").slice(0, 2000), userId || null, !!enabled, tyPage ? String(tyPage).trim().slice(0, 500) : null]
    );
    return result.rows[0].id;
  } catch (err) {
    if (err.code === "23505") throw new Error("Esiste già un calendario con slug \"" + cleanSlug + "\" su questo sito.");
    throw err;
  }
}

export async function updateCalendar(siteId, calendarId, { name, slug, description = "", userId = null, enabled = true, tyPage = "" }) {
  const cleanSlug = sanitizeCalendarSlug(slug || name);
  const cleanName = String(name || "").trim().slice(0, 255);
  if (!cleanSlug || !cleanName) throw new Error("Nome e slug del calendario sono obbligatori.");
  try {
    await query(
      `UPDATE calendars SET slug = $3, name = $4, description = $5, user_id = $6, enabled = $7, ty_page = $8, updated_at = NOW()
       WHERE site_id = $1 AND id = $2`,
      [siteId, calendarId, cleanSlug, cleanName, String(description || "").slice(0, 2000), userId || null, !!enabled, tyPage ? String(tyPage).trim().slice(0, 500) : null]
    );
  } catch (err) {
    if (err.code === "23505") throw new Error("Esiste già un calendario con slug \"" + cleanSlug + "\" su questo sito.");
    throw err;
  }
}

export async function deleteCalendar(siteId, calendarId) {
  // ON DELETE CASCADE sulle regole, ON DELETE SET NULL sulle chiamate: lo
  // storico delle prenotazioni resta, solo scollegato dal calendario.
  await query("DELETE FROM calendars WHERE site_id = $1 AND id = $2", [siteId, calendarId]);
}

export async function listSiteUsers(siteId) {
  const isSuperadminSite = siteId === null;
  const params = isSuperadminSite ? [] : [siteId];
  const where = isSuperadminSite ? "" : "WHERE site_id = $1";
  return (await query(
    `SELECT id, email, name, role FROM users ${where} ORDER BY email`,
    params
  )).rows;
}

function timeToMinutes(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}

// Slot liberi nei prossimi N giorni: incrocia le regole ricorrenti (del
// calendario se specificato, altrimenti site-wide) con le chiamate già
// prenotate (status 'programmata') per escludere sovrapposizioni.
export async function computeAvailableSlots(siteId, { days = DEFAULT_DAYS_AHEAD, calendarId = null } = {}) {
  const rules = await getAvailabilityRules(siteId, calendarId);
  if (rules.length === 0) return [];

  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86400000);

  const booked = (await query(
    `SELECT scheduled_at, duration_minutes FROM calls
     WHERE site_id = $1 AND status = 'programmata' AND scheduled_at BETWEEN $2 AND $3
       AND calendar_id IS NOT DISTINCT FROM $4`,
    [siteId, now, horizon, calendarId]
  )).rows;

  const slots = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const dayRules = rules.filter(r => r.weekday === day.getDay());

    for (const rule of dayRules) {
      // Difesa in profondità: regole con slot_minutes <= 0 già salvate in DB
      // (prima della validazione) non devono mai entrare nel loop.
      if (!rule.slot_minutes || rule.slot_minutes <= 0) continue;
      const startMin = timeToMinutes(rule.start_time);
      const endMin = timeToMinutes(rule.end_time);
      for (let m = startMin; m + rule.slot_minutes <= endMin; m += rule.slot_minutes) {
        const slotStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);
        if (slotStart <= now) continue;
        const slotEnd = new Date(slotStart.getTime() + rule.slot_minutes * 60000);

        const conflict = booked.some(b => {
          const bStart = new Date(b.scheduled_at);
          const bEnd = new Date(bStart.getTime() + b.duration_minutes * 60000);
          return slotStart < bEnd && bStart < slotEnd;
        });
        if (!conflict) slots.push({ start: slotStart, duration_minutes: rule.slot_minutes });
      }
    }
  }
  return slots.sort((a, b) => a.start - b.start);
}

function looksBooked(existing, start, durationMinutes) {
  const bStart = new Date(existing.scheduled_at);
  const bEnd = new Date(bStart.getTime() + existing.duration_minutes * 60000);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return start < bEnd && bStart < end;
}

// Ri-verifica la disponibilità dello slot al momento della prenotazione
// (contro race condition tra il calcolo degli slot mostrati e il submit) —
// send=true invia anche l'email di conferma (non bloccante: se lo SMTP del
// sito non è configurato, la chiamata resta comunque prenotata).
// Race: il vecchio check-then-insert era TOCTOU — due richieste concorrenti
// vedevano entrambe nessun conflitto e inserivano entrambe (doppia
// prenotazione). Ora il check e l'insert sono in una transazione serializzata
// da un advisory lock per coppia (site, slot), quindi il secondo richiedente
// attende e vede la riga inserita dal primo.
export async function bookCall(siteId, { email, name, start, durationMinutes = 30, notify = true, calendarId = null }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const client = await getClient();
  try {
    await client.query("BEGIN");
    // pg_advisory_xact_lock accetta SOLO bigint (o due int4): passare la
    // stringa "call:site:start" dava "invalid input syntax for type bigint"
    // e ogni prenotazione pubblica andava in 500. hashtextextended converte
    // la chiave in un bigint deterministico (stessa stringa → stesso lock).
    // Il calendario entra nella chiave: due calendari diversi dello stesso
    // sito possono avere lo stesso orario senza contendersi il lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`call:${siteId}:${calendarId || "site"}:${start.toISOString()}`]);
    const existing = (await client.query(
      `SELECT scheduled_at, duration_minutes FROM calls
       WHERE site_id = $1 AND status = 'programmata'
         AND calendar_id IS NOT DISTINCT FROM $2
         AND scheduled_at BETWEEN $3 AND $4`,
      [siteId, calendarId, new Date(start.getTime() - 4 * 3600000), new Date(start.getTime() + 4 * 3600000)]
    )).rows;
    if (existing.some(b => looksBooked(b, start, durationMinutes))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "slot_taken" };
    }

    const token = crypto.randomBytes(24).toString("hex");
    const result = await client.query(
      `INSERT INTO calls (site_id, calendar_id, email, name, scheduled_at, duration_minutes, status, booking_token)
       VALUES ($1, $2, $3, $4, $5, $6, 'programmata', $7) RETURNING id`,
      [siteId, calendarId, normalizedEmail, String(name || "").slice(0, 255), start, durationMinutes, token]
    );
    await client.query("COMMIT");

    upsertContact(siteId, normalizedEmail).catch(() => {});

    if (notify) {
      sendBookingConfirmation(siteId, normalizedEmail, start, token)
        .catch(err => logger.error(`Chiamate: email di conferma fallita (site=${siteId}, ${normalizedEmail}): ${err.message}`));
    }

    return { ok: true, id: result.rows[0].id, token };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function sendBookingConfirmation(siteId, email, start, token) {
  const site = (await query("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0];
  const siteName = site?.name || "";
  const when = start.toLocaleString("it-IT", { dateStyle: "full", timeStyle: "short" });
  const baseUrl = await getCanonicalBaseUrl(siteId);
  const cancelUrl = `${baseUrl}/book/cancel/${token}`;
  const { subject, html } = await renderEmail(siteId, "call_confirmation", {
    vars: { siteName, when, cancelUrl },
    defaultSubject: `email.callConfirmation.subject`,
    defaultBody: `<p>La tua chiamata è confermata per <strong>{when}</strong>.</p>
     <p style="margin-top:16px;font-size:13px;"><a href="{cancelUrl}">Annulla la prenotazione</a></p>`,
  });
  await sendSiteEmail(siteId, email, subject, html);
}

const REMINDER_WINDOW_HOURS = 1;

// Chiamata dallo scheduler (ogni 60s, vedi services/scheduler.js) — stesso
// pattern di sendReviewReminders per le pagine: query delle righe dovute +
// flag reminder_sent_at per non rispedire allo stesso giro successivo.
// Un fallimento di invio per una chiamata non blocca le altre.
export async function sendCallReminders() {
  let due;
  try {
    due = (await query(
      `SELECT id, site_id, email, name, scheduled_at, booking_token
       FROM calls
       WHERE status = 'programmata' AND reminder_sent_at IS NULL
         AND scheduled_at > NOW() AND scheduled_at <= NOW() + ($1 || ' hours')::interval`,
      [REMINDER_WINDOW_HOURS]
    )).rows;
  } catch (err) {
    logger.error(`Chiamate: query promemoria fallita: ${err.message}`);
    return;
  }

  for (const call of due) {
    try {
      const site = (await query("SELECT name FROM sites WHERE id = $1", [call.site_id])).rows[0];
      const when = new Date(call.scheduled_at).toLocaleString("it-IT", { dateStyle: "full", timeStyle: "short" });
      const baseUrl = await getCanonicalBaseUrl(call.site_id);
      const cancelUrl = `${baseUrl}/book/cancel/${call.booking_token}`;
      const { subject, html } = await renderEmail(call.site_id, "call_reminder", {
        vars: { siteName: site?.name || "", when, cancelUrl },
        defaultSubject: `email.callReminder.subject`,
        defaultBody: `<p>Ti ricordiamo la chiamata di <strong>{when}</strong>.</p>
         <p style="margin-top:16px;font-size:13px;"><a href="{cancelUrl}">Annulla la prenotazione</a></p>`,
      });
      await sendSiteEmail(
        call.site_id, call.email, subject, html
      );
      await query("UPDATE calls SET reminder_sent_at = NOW() WHERE id = $1", [call.id]);
      logger.info(`Chiamate: promemoria inviato per #${call.id} (${call.email})`);
    } catch (err) {
      logger.error(`Chiamate: promemoria fallito per #${call.id}: ${err.message}`);
    }
  }
}

export async function cancelCallByToken(token) {
  const result = await query(
    "UPDATE calls SET status = 'annullata', updated_at = NOW() WHERE booking_token = $1 AND status = 'programmata' RETURNING id, email, scheduled_at",
    [token]
  );
  return result.rows[0] || null;
}

export async function listUpcomingCalls(siteId, { limit = 200, calendarId = null } = {}) {
  return (await query(
    `SELECT id, calendar_id, email, name, scheduled_at, duration_minutes, status, outcome_notes, booking_token, reminder_sent_at
     FROM calls WHERE site_id = $1 AND calendar_id IS NOT DISTINCT FROM $2 ORDER BY scheduled_at DESC LIMIT $3`,
    [siteId, calendarId, limit]
  )).rows;
}

// Per la tabella admin: tutte le chiamate del sito con il nome del calendario
// (NULL = legacy site-wide) — la lista admin deve mostrare anche le chiamate
// senza calendario, non solo quelle di uno specifico.
export async function listAllCallsForSite(siteId, { limit = 200 } = {}) {
  return (await query(
    `SELECT c.id, c.calendar_id, cal.name AS calendar_name, c.email, c.name, c.scheduled_at, c.duration_minutes, c.status, c.outcome_notes, c.booking_token, c.reminder_sent_at
     FROM calls c
     LEFT JOIN calendars cal ON cal.id = c.calendar_id
     WHERE c.site_id = $1 ORDER BY c.scheduled_at DESC LIMIT $2`,
    [siteId, limit]
  )).rows;
}

export async function listCallsForContact(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();
  return (await query(
    `SELECT id, scheduled_at, duration_minutes, status, outcome_notes, booking_token
     FROM calls WHERE site_id = $1 AND email = $2 ORDER BY scheduled_at DESC`,
    [siteId, normalized]
  )).rows;
}

export async function scheduleCallManually(siteId, { email, name, start, durationMinutes = 30, createdBy, calendarId = null }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  // Controllo conflitto anche sulla prenotazione manuale (prima non c'era
  // proprio: si poteva prenotare un orario già occupato senza nemmeno la
  // concorrenza). Stessa finestra di lookahead di bookCall, stesso scope
  // calendario (un orario occupato in un calendario non blocca gli altri).
  const existing = (await query(
    `SELECT scheduled_at, duration_minutes FROM calls
     WHERE site_id = $1 AND status = 'programmata'
       AND calendar_id IS NOT DISTINCT FROM $2
       AND scheduled_at BETWEEN $3 AND $4`,
    [siteId, calendarId, new Date(start.getTime() - 4 * 3600000), new Date(start.getTime() + 4 * 3600000)]
  )).rows;
  if (existing.some(b => looksBooked(b, start, durationMinutes))) {
    throw new Error("slot_taken");
  }
  const token = crypto.randomBytes(24).toString("hex");
  const result = await query(
    `INSERT INTO calls (site_id, calendar_id, email, name, scheduled_at, duration_minutes, status, booking_token, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'programmata', $7, $8) RETURNING id`,
    [siteId, calendarId, normalizedEmail, String(name || "").slice(0, 255), start, durationMinutes, token, createdBy || null]
  );
  upsertContact(siteId, normalizedEmail).catch(() => {});
  return { id: result.rows[0].id };
}

const CALL_STATUSES = new Set(["programmata", "completata", "no_show", "annullata"]);

export async function setCallOutcome(siteId, callId, { status, outcomeNotes }) {
  if (!CALL_STATUSES.has(status)) throw new Error("Stato chiamata non valido");
  const result = await query(
    "UPDATE calls SET status = $1, outcome_notes = $2, updated_at = NOW() WHERE id = $3 AND site_id = $4 RETURNING email",
    [status, outcomeNotes || "", callId, siteId]
  );
  const email = result.rows[0]?.email;
  if (email) {
    // Evento per workflow/scoring (fire-and-forget, mai bloccare il chiamante).
    import("./events.js").then(({ emitContactEvent }) =>
      emitContactEvent(siteId, email, "call_status_changed", { status, call_id: callId })
    ).catch(() => {});
  }
}
