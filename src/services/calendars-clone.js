import { query } from "../db.js";
import { ensureExternalId, findByExternalId, getExternalId } from "./external-ids.js";
import { computeBookingSlots } from "./booking-slots.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda B: Calendari + appointments unified service.
// Serializza calendars e booking_appointments in shape clone API (camelCase, uuid esterni).
// ─────────────────────────────────────────────────────────────────────────

async function serializeCalendar(row, locationId) {
  if (!row) return null;
  const externalId = await getExternalId("calendars", row.id);
  return {
    id: externalId,
    locationId,
    name: row.name,
    description: row.description || "",
    slug: row.slug,
    isActive: row.enabled,
    teamMembers: [],
    timezone: row.timezone || null,
    dateAdded: row.created_at.toISOString(),
    dateUpdated: row.updated_at.toISOString(),
  };
}

async function serializeEvent(row, locationId) {
  if (!row) return null;
  const externalId = await getExternalId("booking_appointments", row.id);
  const calendarExternalId = row.calendar_id
    ? await getExternalId("calendars", row.calendar_id)
    : null;
  return {
    eventId: externalId,
    calendarId: calendarExternalId,
    title: row.title,
    status: row.appointment_status || mapLegacyStatus(row.status),
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    address: null,
    assignedTo: null,
    contactId: null,
    dateAdded: row.created_at.toISOString(),
  };
}

function mapLegacyStatus(legacyStatus) {
  const map = {
    pending: "new",
    confirmed: "confirmed",
    completed: "showed",
    cancelled: "cancelled",
  };
  return map[legacyStatus] || "new";
}

function mapTargetStatusToLegacy(targetStatus) {
  const map = {
    new: "pending",
    confirmed: "confirmed",
    showed: "completed",
    noshow: "confirmed", // legacy non ha noshow → resta confirmed ma appointment_status='noshow'
    cancelled: "cancelled",
  };
  return map[targetStatus] || "pending";
}

// ── Calendari ────────────────────────────────────────────────────────────

export async function listCalendars(siteId, { limit = 20, startAfterId = null } = {}, locationId) {
  let query_str = "SELECT * FROM calendars WHERE site_id = $1 ORDER BY id ASC";
  const params = [siteId];

  if (startAfterId) {
    const offsetRow = await query("SELECT id FROM calendars WHERE external_id = $1", [startAfterId]);
    if (offsetRow.rows[0]) {
      const offsetId = offsetRow.rows[0].id;
      query_str += ` AND id > $${params.length + 1}`;
      params.push(offsetId);
    }
  }

  query_str += ` LIMIT $${params.length + 1}`;
  params.push(limit + 1);

  const result = await query(query_str, params);
  const rows = result.rows;
  const hasMore = rows.length > limit;
  const calendars = rows.slice(0, limit);

  const total = (await query("SELECT COUNT(*) FROM calendars WHERE site_id = $1", [siteId])).rows[0].count;

  const nextStartAfterId = hasMore ? (await getExternalId("calendars", calendars[calendars.length - 1].id)) : null;

  const serialized = await Promise.all(calendars.map((c) => serializeCalendar(c, locationId)));
  return { calendars: serialized, total: parseInt(total, 10), nextStartAfterId };
}

export async function createCalendar(siteId, input, locationId) {
  let { name, description, slug, isActive, teamMembers, timezone } = input;

  if (!name) throw new Error("Nome calendario obbligatorio");

  // slug auto dal name se assente
  if (!slug) {
    slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  }

  // verifica slug univoco per site
  const exists = await query("SELECT id FROM calendars WHERE site_id = $1 AND slug = $2", [siteId, slug]);
  if (exists.rows[0]) {
    const err = new Error("Slug già in uso");
    err.statusCode = 409;
    throw err;
  }

  description = description || "";
  isActive = isActive !== false;
  timezone = timezone || null;

  const result = await query(
    `INSERT INTO calendars (site_id, slug, name, description, enabled, timezone, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING *`,
    [siteId, slug, name, description, isActive, timezone]
  );

  const calendar = result.rows[0];

  // team members opzionali (uuid user)
  if (Array.isArray(teamMembers) && teamMembers.length > 0) {
    for (const userUuid of teamMembers) {
      const userRow = await findByExternalId("users", userUuid);
      if (userRow) {
        await query(
          `INSERT INTO calendar_members (site_id, calendar_id, user_id, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (calendar_id, user_id) DO NOTHING`,
          [siteId, calendar.id, userRow.id]
        );
      }
    }
  }

  return serializeCalendar(calendar, locationId);
}

export async function getCalendar(siteId, externalId, locationId) {
  const row = await findByExternalId("calendars", externalId);
  if (!row || row.site_id !== siteId) return null;

  const calendar = await serializeCalendar(row, locationId);

  // carica team members
  const members = await query(
    `SELECT u.external_id FROM calendar_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.calendar_id = $1`,
    [row.id]
  );

  calendar.teamMembers = members.rows.map((m) => m.external_id);
  return calendar;
}

export async function updateCalendar(siteId, externalId, input, locationId) {
  const row = await findByExternalId("calendars", externalId);
  if (!row || row.site_id !== siteId) return null;

  const updates = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.isActive !== undefined) updates.enabled = input.isActive;
  if (input.timezone !== undefined) updates.timezone = input.timezone;

  const fields = Object.keys(updates);
  if (fields.length > 0) {
    const setClause = fields.map((f, i) => `${f === "enabled" ? "enabled" : f} = $${i + 2}`).join(", ");
    const params = [row.id, ...Object.values(updates)];
    await query(`UPDATE calendars SET ${setClause}, updated_at = NOW() WHERE id = $1`, params);
  }

  // team members replacement se presente
  if (Array.isArray(input.teamMembers)) {
    await query("DELETE FROM calendar_members WHERE calendar_id = $1", [row.id]);
    for (const userUuid of input.teamMembers) {
      const userRow = await findByExternalId("users", userUuid);
      if (userRow) {
        await query(
          `INSERT INTO calendar_members (site_id, calendar_id, user_id, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (calendar_id, user_id) DO NOTHING`,
          [siteId, row.id, userRow.id]
        );
      }
    }
  }

  const updated = (await query("SELECT * FROM calendars WHERE id = $1", [row.id])).rows[0];
  const calendar = await serializeCalendar(updated, locationId);

  if (Array.isArray(input.teamMembers)) {
    calendar.teamMembers = input.teamMembers;
  } else {
    const members = await query(
      `SELECT u.external_id FROM calendar_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.calendar_id = $1`,
      [row.id]
    );
    calendar.teamMembers = members.rows.map((m) => m.external_id);
  }

  return calendar;
}

export async function deleteCalendar(siteId, externalId) {
  const row = await findByExternalId("calendars", externalId);
  if (!row || row.site_id !== siteId) return 0;

  const result = await query("DELETE FROM calendars WHERE id = $1", [row.id]);
  return result.rowCount;
}

// ── Appuntamenti ─────────────────────────────────────────────────────────

export async function listAppointments(
  siteId,
  {
    calendarId = null,
    userId = null,
    startDate = null,
    endDate = null,
    limit = 20,
    startAfterId = null,
  } = {},
  locationId
) {
  let query_str = "SELECT * FROM booking_appointments WHERE site_id = $1 AND status != 'cancelled'";
  const params = [siteId];

  if (calendarId) {
    const calRow = await findByExternalId("calendars", calendarId);
    if (calRow) {
      query_str += ` AND calendar_id = $${params.length + 1}`;
      params.push(calRow.id);
    } else {
      return { events: [], total: 0, nextStartAfterId: null };
    }
  }

  if (startDate) {
    query_str += ` AND start_time >= $${params.length + 1}`;
    params.push(new Date(startDate));
  }

  if (endDate) {
    query_str += ` AND start_time <= $${params.length + 1}`;
    params.push(new Date(endDate));
  }

  query_str += ` ORDER BY id ASC`;

  if (startAfterId) {
    const offsetRow = await query("SELECT id FROM booking_appointments WHERE external_id = $1", [startAfterId]);
    if (offsetRow.rows[0]) {
      const offsetId = offsetRow.rows[0].id;
      query_str += ` AND id > $${params.length + 1}`;
      params.push(offsetId);
    }
  }

  query_str += ` LIMIT $${params.length + 1}`;
  params.push(limit + 1);

  const result = await query(query_str, params);
  const rows = result.rows;
  const hasMore = rows.length > limit;
  const appointments = rows.slice(0, limit);

  let totalResult = query_str.replace(/LIMIT.*/, "");
  totalResult = totalResult.replace(/ORDER BY.*/, "");
  totalResult = `SELECT COUNT(*) FROM (${totalResult}) t`;
  const totalCount = (
    await query(totalResult.replace("SELECT COUNT(*)", "SELECT COUNT(*) as count"), params.slice(0, params.length - 1))
  ).rows[0].count;

  const nextStartAfterId = hasMore
    ? await getExternalId("booking_appointments", appointments[appointments.length - 1].id)
    : null;

  const serialized = await Promise.all(appointments.map((a) => serializeEvent(a, locationId)));
  return { events: serialized, total: parseInt(totalCount, 10), nextStartAfterId };
}

export async function createAppointment(siteId, input, locationId) {
  const { calendarId, title, startTime, endTime, email, contactId } = input;

  if (!title || !startTime) throw new Error("Title e startTime obbligatori");

  let calendarIdInt = null;
  if (calendarId) {
    const calRow = await findByExternalId("calendars", calendarId);
    if (calRow && calRow.site_id === siteId) calendarIdInt = calRow.id;
  }

  const endTimeVal = endTime || new Date(new Date(startTime).getTime() + 60 * 60 * 1000);

  // upsert contatto per email (come fa booking.js)
  let contactIdInt = null;
  if (email) {
    const contactRow = await query("SELECT id FROM contacts WHERE site_id = $1 AND email = $2", [siteId, email]);
    if (contactRow.rows[0]) {
      contactIdInt = contactRow.rows[0].id;
    } else {
      const newContact = await query(
        "INSERT INTO contacts (site_id, email, status, created_at) VALUES ($1, $2, 'active', NOW()) RETURNING id",
        [siteId, email]
      );
      contactIdInt = newContact.rows[0].id;
    }
  }

  const result = await query(
    `INSERT INTO booking_appointments (
       site_id, calendar_id, contact_name, contact_email, contact_phone, title,
       description, start_time, end_time, status, appointment_status, timezone, created_at, updated_at
     ) VALUES ($1, $2, '', $3, '', $4, '', $5, $6, 'confirmed', 'confirmed', 'UTC', NOW(), NOW())
     RETURNING *`,
    [siteId, calendarIdInt, email || "", title, startTime, endTimeVal]
  );

  return serializeEvent(result.rows[0], locationId);
}

export async function getAppointment(siteId, eventId, locationId) {
  const row = await findByExternalId("booking_appointments", eventId);
  if (!row || row.site_id !== siteId || row.status === 'cancelled') return null;

  return serializeEvent(row, locationId);
}

export async function updateAppointment(siteId, eventId, input, locationId) {
  const row = await findByExternalId("booking_appointments", eventId);
  if (!row || row.site_id !== siteId) return null;

  const updates = {};

  if (input.title !== undefined) updates.title = input.title;
  if (input.startTime !== undefined) updates.start_time = new Date(input.startTime);
  if (input.endTime !== undefined) updates.end_time = new Date(input.endTime);

  if (input.status !== undefined) {
    const legacyStatus = mapTargetStatusToLegacy(input.status);
    updates.status = legacyStatus;
    updates.appointment_status = input.status;
  }

  const fields = Object.keys(updates);
  if (fields.length > 0) {
    const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const params = [row.id, ...Object.values(updates)];
    await query(`UPDATE booking_appointments SET ${setClause}, updated_at = NOW() WHERE id = $1`, params);
  }

  const updated = (await query("SELECT * FROM booking_appointments WHERE id = $1", [row.id])).rows[0];
  return serializeEvent(updated, locationId);
}

export async function deleteAppointment(siteId, eventId) {
  const row = await findByExternalId("booking_appointments", eventId);
  if (!row || row.site_id !== siteId) return 0;

  await query(
    "UPDATE booking_appointments SET status = 'cancelled', appointment_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1",
    [row.id]
  );

  return 1;
}

// ── Free slots ───────────────────────────────────────────────────────────

export async function getFreeSlots(siteId, calendarId, startDate, endDate, locationId) {
  const calRow = await findByExternalId("calendars", calendarId);
  if (!calRow || calRow.site_id !== siteId) return null;

  const slots = await computeBookingSlots(siteId, { days: 30 });

  // raggruppa per data
  const grouped = {};
  for (const slot of slots) {
    const dateKey = slot.start.toISOString().split("T")[0];
    if (!grouped[dateKey]) {
      grouped[dateKey] = [];
    }
    grouped[dateKey].push({
      startTime: slot.start.toISOString().substring(11, 16),
      endTime: new Date(slot.start.getTime() + slot.duration_minutes * 60000).toISOString().substring(11, 16),
    });
  }

  const result = {};
  for (const [date, slotTimes] of Object.entries(grouped)) {
    result[date] = [
      {
        openHour: 9,
        openMinute: 0,
        closeHour: 18,
        closeMinute: 0,
        slotIntervals: slotTimes,
      },
    ];
  }

  return { slots: result };
}
