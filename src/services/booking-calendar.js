import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// ONDA 2 — Booking Calendar Sync: push booking → Google Calendar.
//
// Servizio leggero che crea/aggiorna/cancella eventi Google Calendar per
// i booking (booking_appointments, 077). Si attiva SOLO se per il tenant
// esiste una config attiva in booking_calendar_config (migrazione 079) con
// una connessione OAuth valida.
//
// Senza config o senza OAuth → nessuna operazione verso Google, nessun
// errore propagato (fire-and-forget, logga e basta).
// ─────────────────────────────────────────────────────────────────────────

const GOOGLE_API_BASE = "https://www.googleapis.com/calendar/v3";
const HTTP_TIMEOUT_MS = 15000;

// ── Config ───────────────────────────────────────────────────────────────

// Legge la config attiva di sync calendario per un sito.
// Ritorna null se non configurata o disattivata.
export async function getBookingCalendarConfig(siteId) {
  try {
    const row = (await query(
      `SELECT id, oauth_connection_id, calendar_id
       FROM booking_calendar_config
       WHERE site_id = $1 AND active = true
       LIMIT 1`,
      [siteId]
    )).rows[0];

    if (!row) return null;

    // Verifica che la connessione OAuth esista e sia attiva
    const conn = (await query(
      `SELECT id, access_token, refresh_token, token_expires_at
       FROM oauth_connections
       WHERE id = $1 AND active = true AND access_token <> ''`,
      [row.oauth_connection_id]
    )).rows[0];

    if (!conn) {
      logger.warn(`booking-calendar: OAuth connection ${row.oauth_connection_id} non trovata/non attiva (site=${siteId})`);
      return null;
    }

    return {
      configId: row.id,
      calendarId: row.calendar_id || "primary",
      oauthConnectionId: row.oauth_connection_id,
      accessToken: conn.access_token,
    };
  } catch (err) {
    // 42P01 = tabella booking_calendar_config o oauth_connections non esiste
    if (err.code === "42P01") {
      logger.warn(`booking-calendar: tabella non presente (site=${siteId}): ${err.code}`);
      return null;
    }
    logger.warn(`booking-calendar: lettura config fallita (site=${siteId}): ${err.message}`);
    return null;
  }
}

// ── Helper HTTP verso Google ──────────────────────────────────────────────

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
  return err?.name === "AbortError"
    ? `timeout dopo ${HTTP_TIMEOUT_MS / 1000}s`
    : (err?.message || String(err));
}

// ── CRUD eventi Google Calendar ──────────────────────────────────────────

// Crea un evento Google Calendar per il booking.
// Ritorna { googleEventId: string } in caso di successo.
// Ritorna { error: string } in caso di fallimento (mai throw).
export async function createCalendarEvent(booking, config) {
  if (!booking || !config || !config.accessToken) {
    return { error: "Config OAuth non disponibile" };
  }

  const calendarId = encodeURIComponent(config.calendarId);
  const url = `${GOOGLE_API_BASE}/calendars/${calendarId}/events`;
  const headers = {
    Authorization: `Bearer ${config.accessToken}`,
    "Content-Type": "application/json",
  };

  const start = new Date(booking.start_time).toISOString();
  const end = new Date(booking.end_time).toISOString();
  const summary = booking.title || "Prenotazione";
  const description = [
    `Nome: ${booking.contact_name || ""}`,
    `Email: ${booking.contact_email || ""}`,
    `Telefono: ${booking.contact_phone || ""}`,
    booking.description ? `Note: ${booking.description}` : "",
  ].filter(Boolean).join("\n");

  const body = {
    summary,
    description,
    start: { dateTime: start, timeZone: booking.timezone || "UTC" },
    end: { dateTime: end, timeZone: booking.timezone || "UTC" },
  };

  try {
    const res = await googleFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `Google Calendar: HTTP ${res.status} ${String(text).slice(0, 200)}` };
    }

    const data = await res.json();
    if (!data.id) {
      return { error: "Google Calendar: risposta senza id evento" };
    }

    return { googleEventId: data.id };
  } catch (err) {
    return { error: `Google Calendar: ${errorMessage(err)}` };
  }
}

// Aggiorna un evento Google Calendar esistente.
// Ritorna { ok: true } in caso di successo, { error: string } altrimenti.
export async function updateCalendarEvent(booking, config) {
  if (!booking || !config || !config.accessToken || !booking.google_event_id) {
    return { error: "google_event_id o Config OAuth non disponibile" };
  }

  const calendarId = encodeURIComponent(config.calendarId);
  const eventId = encodeURIComponent(booking.google_event_id);
  const url = `${GOOGLE_API_BASE}/calendars/${calendarId}/events/${eventId}`;
  const headers = {
    Authorization: `Bearer ${config.accessToken}`,
    "Content-Type": "application/json",
  };

  const start = new Date(booking.start_time).toISOString();
  const end = new Date(booking.end_time).toISOString();
  const summary = booking.title || "Prenotazione";
  const description = [
    `Nome: ${booking.contact_name || ""}`,
    `Email: ${booking.contact_email || ""}`,
    `Telefono: ${booking.contact_phone || ""}`,
    booking.description ? `Note: ${booking.description}` : "",
  ].filter(Boolean).join("\n");

  const body = {
    summary,
    description,
    start: { dateTime: start, timeZone: booking.timezone || "UTC" },
    end: { dateTime: end, timeZone: booking.timezone || "UTC" },
  };

  try {
    const res = await googleFetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `Google Calendar: HTTP ${res.status} ${String(text).slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    return { error: `Google Calendar: ${errorMessage(err)}` };
  }
}

// Cancella un evento Google Calendar.
// Ritorna { ok: true } in caso di successo, { error: string } altrimenti.
export async function deleteCalendarEvent(googleEventId, config) {
  if (!googleEventId || !config || !config.accessToken) {
    return { error: "google_event_id o Config OAuth non disponibile" };
  }

  const calendarId = encodeURIComponent(config.calendarId);
  const eventId = encodeURIComponent(googleEventId);
  const url = `${GOOGLE_API_BASE}/calendars/${calendarId}/events/${eventId}`;
  const headers = { Authorization: `Bearer ${config.accessToken}` };

  try {
    const res = await googleFetch(url, {
      method: "DELETE",
      headers,
    });

    if (res.status === 404) {
      // Evento già cancellato su Google → consideralo successo
      return { ok: true };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `Google Calendar: HTTP ${res.status} ${String(text).slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    return { error: `Google Calendar: ${errorMessage(err)}` };
  }
}

// ── Fire-and-forget: tenta il sync, non blocca mai ────────────────────────

// Tenta di creare un evento Google Calendar per il booking e salva
// google_event_id. Non lancia eccezioni: logga e basta.
export async function tryCreateEvent(booking) {
  if (!booking || !booking.site_id) return;
  try {
    const config = await getBookingCalendarConfig(booking.site_id);
    if (!config) {
      // Nessuna config: booking funziona senza Google Calendar, normale
      return;
    }

    const result = await createCalendarEvent(booking, config);
    if (result.error) {
      logger.warn(`booking-calendar: creazione evento fallita (booking=${booking.id}): ${result.error}`);
      return;
    }

    if (result.googleEventId) {
      await query(
        "UPDATE booking_appointments SET google_event_id = $1, updated_at = NOW() WHERE id = $2",
        [result.googleEventId, booking.id]
      );
      logger.info(`booking-calendar: evento creato (booking=${booking.id}, google_event_id=${result.googleEventId})`);
    }
  } catch (err) {
    logger.warn(`booking-calendar: tryCreateEvent fallito (booking=${booking?.id}): ${err.message}`);
  }
}

// Tenta di cancellare l'evento Google Calendar associato al booking e
// azzera google_event_id. Non lancia eccezioni: logga e basta.
export async function tryDeleteEvent(booking) {
  if (!booking || !booking.site_id || !booking.google_event_id) return;
  const googleEventId = booking.google_event_id;
  try {
    const config = await getBookingCalendarConfig(booking.site_id);
    if (!config) {
      // Config rimossa dopo la creazione del booking: azzera solo il DB
      logger.warn(`booking-calendar: config non trovata per cancellazione (booking=${booking.id}) — azzero google_event_id`);
      await query(
        "UPDATE booking_appointments SET google_event_id = NULL, updated_at = NOW() WHERE id = $1",
        [booking.id]
      );
      return;
    }

    const result = await deleteCalendarEvent(googleEventId, config);
    if (result.error) {
      logger.warn(`booking-calendar: cancellazione evento fallita (booking=${booking.id}): ${result.error}`);
      // Comunque azzero google_event_id: l'evento su Google ormai è orfano
    }

    await query(
      "UPDATE booking_appointments SET google_event_id = NULL, updated_at = NOW() WHERE id = $1",
      [booking.id]
    );
    logger.info(`booking-calendar: evento cancellato (booking=${booking.id})`);
  } catch (err) {
    logger.warn(`booking-calendar: tryDeleteEvent fallito (booking=${booking?.id}): ${err.message}`);
  }
}