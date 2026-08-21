import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// ONDA 2 — Booking system: appuntamenti prenotati dai contatti.
//
// CRUD per booking_appointments (tabella 077), con emissione evento
// booking_created via events.js per il webhook OUT verso n8n.
//
// Validazione base: start_time obbligatorio, end_time opzionale (default
// start_time + 30 min), title e contact_email obbligatori.
// ─────────────────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set(["pending", "confirmed", "cancelled", "completed"]);

function sanitizeStatus(raw) {
  if (!raw) return "confirmed";
  const v = String(raw).trim().toLowerCase();
  return VALID_STATUSES.has(v) ? v : "confirmed";
}

function sanitizeTime(raw, fallback) {
  if (raw instanceof Date) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return fallback;
  return d;
}

// ── Config per-tenant per il booking ─────────────────────────────────────
// Legge le chiavi booking_* da tenant_config (F0) e ritorna un oggetto con
// i default sanificati. Se una chiave manca → la voce è assente, così i
// check/default opzionali non vengono applicati.
//
// Chiavi supportate:
//   - booking_duration_minutes : durata default end_time (default: 30)
//   - booking_timezone         : timezone default (default: UTC)
//   - booking_lead_time_hours  : ore minime nel futuro per start_time
//   - booking_window_days      : giorni massimi nel futuro per start_time
async function readBookingConfig(siteId) {
  const cfg = {};
  try {
    const rows = (await query(
      "SELECT key, value FROM tenant_config WHERE site_id = $1",
      [siteId]
    )).rows;
    const map = {};
    for (const r of rows) map[r.key] = r.value;

    const dur = parseInt(map.booking_duration_minutes, 10);
    if (Number.isInteger(dur) && dur > 0) cfg.durationMinutes = dur;

    if (map.booking_timezone && typeof map.booking_timezone === "string" && map.booking_timezone.trim()) {
      cfg.timezone = map.booking_timezone.trim().slice(0, 50);
    }

    const lead = parseInt(map.booking_lead_time_hours, 10);
    if (Number.isInteger(lead) && lead >= 0) cfg.leadTimeHours = lead;

    const win = parseInt(map.booking_window_days, 10);
    if (Number.isInteger(win) && win >= 0) cfg.windowDays = win;

    // booking_auto_create_contact: default true se assente o non booleano valido
    if (map.booking_auto_create_contact === false || map.booking_auto_create_contact === "false") {
      cfg.autoCreateContact = false;
    } else {
      cfg.autoCreateContact = map.booking_auto_create_contact !== undefined
        ? Boolean(map.booking_auto_create_contact) : true;
    }
  } catch (err) {
    // La lettura della config non deve MAI far fallire la creazione: in caso
    // di errore si procede con i default "nulli" (nessuna voce applicata).
    logger.warn(`booking: lettura tenant_config fallita (site=${siteId}): ${err.message}`);
  }
  return cfg;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function listBookings(siteId, { status, contactEmail, limit, offset } = {}) {
  const conditions = ["site_id = $1"];
  const params = [siteId];
  let idx = 2;

  if (status) {
    conditions.push(`status = $${idx}`);
    params.push(String(status).trim().toLowerCase());
    idx++;
  }
  if (contactEmail) {
    conditions.push(`contact_email = $${idx}`);
    params.push(String(contactEmail).trim().toLowerCase());
    idx++;
  }

  const limitVal = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const offsetVal = Math.max(parseInt(offset, 10) || 0, 0);

  const countResult = await query(
    `SELECT COUNT(*) AS total FROM booking_appointments WHERE ${conditions.join(" AND ")}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const rows = await query(
    `SELECT * FROM booking_appointments WHERE ${conditions.join(" AND ")} ORDER BY start_time DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limitVal, offsetVal]
  );

  return { bookings: rows.rows, total };
}

export async function getBooking(siteId, id) {
  const result = await query(
    "SELECT * FROM booking_appointments WHERE site_id = $1 AND id = $2",
    [siteId, parseInt(id, 10)]
  );
  return result.rows[0] || null;
}

export async function createBooking(siteId, data = {}) {
  const cfg = await readBookingConfig(siteId);

  const contactName = String(data.contact_name || "").trim().slice(0, 255);
  const contactEmail = String(data.contact_email || "").trim().toLowerCase().slice(0, 255);
  const contactPhone = String(data.contact_phone || "").trim().slice(0, 50);
  const title = String(data.title || "").trim().slice(0, 255);
  const description = String(data.description || "").trim();
  const timezone = String(data.timezone || cfg.timezone || "UTC").trim().slice(0, 50);

  if (!contactEmail) throw Object.assign(new Error("contact_email è obbligatorio"), { statusCode: 400 });
  if (!title) throw Object.assign(new Error("title è obbligatorio"), { statusCode: 400 });

  const startTime = sanitizeTime(data.start_time, null);
  if (!startTime) throw Object.assign(new Error("start_time è obbligatorio e deve essere una data valida"), { statusCode: 400 });

  // Check finestra prenotabile (lead time minimo nel futuro, finestra massima).
  if (startTime < Date.now()) {
    if (cfg.leadTimeHours !== undefined) {
      throw Object.assign(new Error("start_time non può essere nel passato"), { statusCode: 400 });
    }
  }
  if (cfg.leadTimeHours !== undefined) {
    const minStart = new Date(Date.now() + cfg.leadTimeHours * 3600 * 1000);
    if (startTime < minStart) {
      throw Object.assign(new Error(`start_time deve essere almeno ${cfg.leadTimeHours} ore nel futuro`), { statusCode: 400 });
    }
  }
  if (cfg.windowDays !== undefined) {
    const maxStart = new Date(Date.now() + cfg.windowDays * 86400 * 1000);
    if (startTime > maxStart) {
      throw Object.assign(new Error(`start_time non può superare ${cfg.windowDays} giorni nel futuro`), { statusCode: 400 });
    }
  }

  const defaultDurationMin = cfg.durationMinutes !== undefined ? cfg.durationMinutes : 30;
  let endTime = sanitizeTime(data.end_time, null);
  if (!endTime) {
    endTime = new Date(startTime.getTime() + defaultDurationMin * 60 * 1000);
  }
  if (endTime <= startTime) {
    endTime = new Date(startTime.getTime() + defaultDurationMin * 60 * 1000);
  }

  const result = await query(
    `INSERT INTO booking_appointments
       (site_id, contact_name, contact_email, contact_phone, title, description,
        start_time, end_time, status, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [siteId, contactName, contactEmail, contactPhone, title, description,
     startTime, endTime, "confirmed", timezone]
  );

  const booking = result.rows[0];

  // Auto-create/update contatto CRM (fire-and-forget, controllato da config)
  try {
    const cfgContact = await readBookingConfig(siteId);
    if (cfgContact.autoCreateContact !== false) {
      const { upsertContactByEmail } = await import("./contacts-v1.js");
      upsertContactByEmail(siteId, contactEmail, {
        name: contactName,
        phone: contactPhone || undefined,
      }).catch((err) => {
        logger.warn(`booking: upsertContactByEmail fallito (email=${contactEmail}): ${err.message}`);
      });
    }
  } catch (err) {
    logger.warn(`booking: auto-create contact fallito: ${err.message}`);
  }

  // Emetti evento booking_created → webhook OUT (fire-and-forget)
  try {
    const { emitContactEvent } = await import("./events.js");
    emitContactEvent(siteId, contactEmail, "booking_created", {
      booking_id: booking.id,
      title: booking.title,
      start_time: booking.start_time.toISOString?.() || String(booking.start_time),
      end_time: booking.end_time.toISOString?.() || String(booking.end_time),
      status: booking.status,
    }).catch((err) => {
      logger.warn(`booking: emitContactEvent booking_created fallito (id=${booking.id}): ${err.message}`);
    });
  } catch (err) {
    logger.warn(`booking: import events.js fallito: ${err.message}`);
  }

  // Google Calendar sync (fire-and-forget): crea evento se configurato
  try {
    const { tryCreateEvent } = await import("./booking-calendar.js");
    tryCreateEvent(booking).catch((err) => {
      logger.warn(`booking: tryCreateEvent fallito (id=${booking.id}): ${err.message}`);
    });
  } catch (err) {
    logger.warn(`booking: import booking-calendar.js fallito: ${err.message}`);
  }

  return booking;
}

export async function updateBooking(siteId, id, data = {}) {
  const existing = await getBooking(siteId, id);
  if (!existing) throw Object.assign(new Error("Booking non trovato"), { statusCode: 404 });

  const fields = [];
  const params = [];
  let idx = 1;

  const pushField = (col, value) => {
    fields.push(`${col} = $${idx}`);
    params.push(value);
    idx++;
  };

  if (data.contact_name !== undefined) pushField("contact_name", String(data.contact_name).trim().slice(0, 255));
  if (data.contact_email !== undefined) pushField("contact_email", String(data.contact_email).trim().toLowerCase().slice(0, 255));
  if (data.contact_phone !== undefined) pushField("contact_phone", String(data.contact_phone).trim().slice(0, 50));
  if (data.title !== undefined) pushField("title", String(data.title).trim().slice(0, 255));
  if (data.description !== undefined) pushField("description", String(data.description).trim());
  if (data.timezone !== undefined) pushField("timezone", String(data.timezone).trim().slice(0, 50));
  if (data.status !== undefined) pushField("status", sanitizeStatus(data.status));
  if (data.google_event_id !== undefined) pushField("google_event_id", data.google_event_id || null);
  if (data.start_time !== undefined) pushField("start_time", sanitizeTime(data.start_time, existing.start_time));
  if (data.end_time !== undefined) pushField("end_time", sanitizeTime(data.end_time, existing.end_time));

  if (fields.length === 0) return existing;

  fields.push("updated_at = NOW()");

  params.push(parseInt(id, 10), siteId);
  const result = await query(
    `UPDATE booking_appointments SET ${fields.join(", ")} WHERE id = $${idx} AND site_id = $${idx + 1} RETURNING *`,
    params
  );

  const updatedBooking = result.rows[0] || null;
  if (!updatedBooking) return null;

  // Google Calendar sync (fire-and-forget): aggiorna evento se configurato
  // e il booking originale aveva un google_event_id
  if (existing.google_event_id) {
    try {
      const { tryUpdateEvent } = await import("./booking-calendar.js");
      tryUpdateEvent(updatedBooking).catch((err) => {
        logger.warn(`booking: tryUpdateEvent fallito (id=${id}): ${err.message}`);
      });
    } catch (err) {
      logger.warn(`booking: import booking-calendar.js fallito: ${err.message}`);
    }
  }

  return updatedBooking;
}

export async function cancelBooking(siteId, id) {
  const existing = await getBooking(siteId, id);
  if (!existing) throw Object.assign(new Error("Booking non trovato"), { statusCode: 404 });
  if (existing.status === "cancelled") return existing;

  const result = await query(
    `UPDATE booking_appointments
     SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND site_id = $2
     RETURNING *`,
    [parseInt(id, 10), siteId]
  );

  const booking = result.rows[0];

  // Emetti evento booking_cancelled
  try {
    const { emitContactEvent } = await import("./events.js");
    emitContactEvent(siteId, booking.contact_email, "booking_cancelled", {
      booking_id: booking.id,
      title: booking.title,
    }).catch(() => {});
  } catch {}

  // Google Calendar sync (fire-and-forget): cancella evento se configurato
  try {
    const { tryDeleteEvent } = await import("./booking-calendar.js");
    tryDeleteEvent(booking).catch((err) => {
      logger.warn(`booking: tryDeleteEvent fallito (id=${booking.id}): ${err.message}`);
    });
  } catch (err) {
    logger.warn(`booking: import booking-calendar.js fallito: ${err.message}`);
  }

  return booking;
}