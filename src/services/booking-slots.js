import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// ONDA 2 Phase 3 — Booking slot computation.
//
// Calcola gli slot disponibili per il booking pubblico basandosi sulle
// chiavi di tenant_config. Nessuna tabella di regole dedicata — la
// configurazione e' per-tenant via chiavi booking_*.
//
// Chiavi tenant_config supportate:
//   booking_slot_minutes    — durata di ogni slot (default: 60)
//   booking_hours_start     — ora di inizio finestra, formato HH:MM (default: "09:00")
//   booking_hours_end       — ora di fine finestra, formato HH:MM (default: "18:00")
//   booking_available_days  — giorni settimana disponibili, CSV 0-6 (default: "1,2,3,4,5")
//   booking_lead_time_hours — ore minime di preavviso dal momento corrente (default: 1)
//   booking_window_days     — giorni massimi nel futuro (default: 14)
// ─────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  slotMinutes: 60,
  hoursStart: "09:00",
  hoursEnd: "18:00",
  availableDays: [1, 2, 3, 4, 5],
  leadTimeHours: 1,
  windowDays: 14,
};

/**
 * Legge la configurazione booking da tenant_config con fallback ai default.
 * Ritorna un oggetto con le chiavi normalizzate.
 */
async function readSlotConfig(siteId) {
  const cfg = { ...DEFAULTS };

  try {
    const rows = (await query(
      "SELECT key, value FROM tenant_config WHERE site_id = $1",
      [siteId]
    )).rows;
    const map = {};
    for (const r of rows) map[r.key] = r.value;

    const slotMin = parseInt(map.booking_slot_minutes, 10);
    if (Number.isInteger(slotMin) && slotMin >= 5 && slotMin <= 480) {
      cfg.slotMinutes = slotMin;
    }

    if (map.booking_hours_start && /^\d{2}:\d{2}$/.test(String(map.booking_hours_start))) {
      cfg.hoursStart = String(map.booking_hours_start).trim();
    }
    if (map.booking_hours_end && /^\d{2}:\d{2}$/.test(String(map.booking_hours_end))) {
      cfg.hoursEnd = String(map.booking_hours_end).trim();
    }

    if (map.booking_available_days && typeof map.booking_available_days === "string") {
      const days = map.booking_available_days
        .split(",")
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
      if (days.length > 0) cfg.availableDays = days;
    }

    const lead = parseInt(map.booking_lead_time_hours, 10);
    if (Number.isInteger(lead) && lead >= 0) {
      cfg.leadTimeHours = lead;
    }

    const win = parseInt(map.booking_window_days, 10);
    if (Number.isInteger(win) && win > 0) {
      cfg.windowDays = win;
    }
  } catch (err) {
    logger.warn(`booking-slots: lettura config fallita (site=${siteId}): ${err.message}`);
  }

  return cfg;
}

/**
 * Converte una stringa HH:MM in minuti dalla mezzanotte.
 */
function timeToMinutes(str) {
  const [h, m] = str.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Computa gli slot disponibili per un sito.
 *
 * @param {number} siteId
 * @param {object} [opts]
 * @param {number} [opts.days=14] — giorni nel futuro da considerare
 * @returns {Promise<Array<{start: Date, duration_minutes: number}>>}
 */
export async function computeBookingSlots(siteId, { days } = {}) {
  const cfg = await readSlotConfig(siteId);
  const horizon = days !== undefined ? days : cfg.windowDays;
  const now = new Date();

  const startMin = timeToMinutes(cfg.hoursStart);
  const endMin = timeToMinutes(cfg.hoursEnd);

  if (endMin <= startMin) return [];

  // Booking esistenti (non cancellati) nel periodo considerato
  const booked = (await query(
    `SELECT start_time, end_time FROM booking_appointments
     WHERE site_id = $1 AND status != 'cancelled'
       AND start_time BETWEEN $2 AND $3`,
    [siteId, now, new Date(now.getTime() + horizon * 86400000)]
  )).rows;

  const slots = [];

  for (let d = 0; d < horizon; d++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
    const weekday = day.getUTCDay();

    if (!cfg.availableDays.includes(weekday)) continue;

    for (let m = startMin; m + cfg.slotMinutes <= endMin; m += cfg.slotMinutes) {
      const slotStart = new Date(day.getTime() + m * 60000);

      // Escludi slot nel passato o con lead time insufficiente
      const minStart = new Date(now.getTime() + cfg.leadTimeHours * 3600000);
      if (slotStart <= minStart) continue;

      const slotEnd = new Date(slotStart.getTime() + cfg.slotMinutes * 60000);

      // Controllo conflitto con booking esistenti
      const conflict = booked.some(b => {
        const bStart = new Date(b.start_time);
        const bEnd = new Date(b.end_time);
        return slotStart < bEnd && bStart < slotEnd;
      });

      if (!conflict) {
        slots.push({ start: slotStart, duration_minutes: cfg.slotMinutes });
      }
    }
  }

  return slots.sort((a, b) => a.start - b.start);
}

/**
 * Raggruppa gli slot per giorno.
 *
 * @param {Array<{start: Date, duration_minutes: number}>} slots
 * @returns {Array<{day: string, slots: Array}>}
 */
export function groupSlotsByDay(slots) {
  const map = {};
  for (const s of slots) {
    const dayKey = s.start.toISOString().slice(0, 10);
    if (!map[dayKey]) map[dayKey] = [];
    map[dayKey].push(s);
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, daySlots]) => ({ day, slots: daySlots }));
}