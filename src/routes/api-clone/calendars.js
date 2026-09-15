import { Router } from "express";
import {
  sendError, httpError, requireAnyId, getPaging, sendList, getLocationId,
} from "./_helpers.js";
import * as calendarsClone from "../../services/calendars-clone.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda B: Calendari e appuntamenti — clone API.
// Pattern: rotte statiche (GET /appointments, GET /calendars) PRIMA di param.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// ── Calendari ────────────────────────────────────────────────────────────

router.get("/calendars", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const result = await calendarsClone.listCalendars(req.tenant.siteId, { limit, startAfterId }, locationId);
    sendList(res, "calendars", result.calendars, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/calendars", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      name: req.body.name,
      description: req.body.description,
      slug: req.body.slug,
      isActive: req.body.isActive,
      teamMembers: req.body.teamMembers,
      timezone: req.body.timezone,
    };

    const calendar = await calendarsClone.createCalendar(req.tenant.siteId, input, locationId);
    res.status(201).json({ calendar });
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, 409, err.message);
    }
    next(err);
  }
});

router.post("/calendars/events/appointments", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      calendarId: req.body.calendarId,
      title: req.body.title,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      email: req.body.email,
      contactId: req.body.contactId,
    };

    const event = await calendarsClone.createAppointment(req.tenant.siteId, input, locationId);
    // sorgente v3 create returns flat object; dual-shape per compatibilità con client esistenti
    res.status(201).json({ ...event, event });
  } catch (err) {
    next(err);
  }
});

// ── Calendar events (sorgente v3: GET /calendars/events?locationId=&calendarId=&startTime=&endTime=) ──
async function handleListCalendarEvents(req, res, next) {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);

    // sorgente uses millis for startTime/endTime; also accept ISO strings
    let { startDate, endDate, startTime, endTime, calendarId, userId } = req.query;
    if (startTime && !startDate) startDate = isNaN(Number(startTime)) ? startTime : new Date(Number(startTime)).toISOString();
    if (endTime && !endDate) endDate = isNaN(Number(endTime)) ? endTime : new Date(Number(endTime)).toISOString();

    const result = await calendarsClone.listAppointments(
      req.tenant.siteId,
      { calendarId: calendarId || null, userId: userId || null, startDate: startDate || null, endDate: endDate || null, limit, startAfterId },
      locationId
    );
    sendList(res, "events", result.events, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
}

router.get("/calendars/events", handleListCalendarEvents);

// ── Get appointment (sorgente v3: GET /calendars/events/appointments/:eventId) ──
async function handleGetAppointment(req, res, next) {
  try {
    const locationId = await getLocationId(req.tenant);
    const eventId = requireAnyId(req.params.eventId, res);
    if (!eventId) return;

    const event = await calendarsClone.getAppointment(req.tenant.siteId, eventId, locationId);
    if (!event) return sendError(res, 404, "Appuntamento non trovato");
    // sorgente v3 get returns wrapped { event: {...} }
    res.json({ event });
  } catch (err) {
    next(err);
  }
}

router.get("/calendars/events/appointments/:eventId", handleGetAppointment);

// ── Update appointment (sorgente v3: PUT /calendars/events/appointments/:eventId) ──
async function handleUpdateAppointment(req, res, next) {
  try {
    const locationId = await getLocationId(req.tenant);
    const eventId = requireAnyId(req.params.eventId, res);
    if (!eventId) return;

    const input = {
      title: req.body.title,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      appointmentStatus: req.body.appointmentStatus || req.body.status,
      assignedUserId: req.body.assignedUserId,
      calendarId: req.body.calendarId,
      description: req.body.description,
      address: req.body.address,
      ignoreFreeSlotValidation: req.body.ignoreFreeSlotValidation,
    };

    const event = await calendarsClone.updateAppointment(req.tenant.siteId, eventId, input, locationId);
    if (!event) return sendError(res, 404, "Appuntamento non trovato");
    // sorgente v3 update returns flat object
    res.json(event);
  } catch (err) {
    next(err);
  }
}

router.put("/calendars/events/appointments/:eventId", handleUpdateAppointment);

// ── Delete event (sorgente v3: DELETE /calendars/events/appointments/:eventId) ──
async function handleDeleteAppointment(req, res, next) {
  try {
    const eventId = requireAnyId(req.params.eventId, res);
    if (!eventId) return;

    const count = await calendarsClone.deleteAppointment(req.tenant.siteId, eventId);
    if (!count) return sendError(res, 404, "Appuntamento non trovato");
    // sorgente v3 delete returns { succeeded: true } with 201
    res.status(201).json({ succeeded: true });
  } catch (err) {
    next(err);
  }
}

// Path allineato a GET/PUT sopra (/calendars/events/appointments/:eventId),
// non /calendars/events/:eventId — coerenza con lo stile REST reale sorgente per
// questa famiglia di risorse.
router.delete("/calendars/events/appointments/:eventId", handleDeleteAppointment);

router.get("/calendars/:calendarId", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const calendarId = requireAnyId(req.params.calendarId, res);
    if (!calendarId) return;

    const calendar = await calendarsClone.getCalendar(req.tenant.siteId, calendarId, locationId);
    if (!calendar) return sendError(res, 404, "Calendario non trovato");
    res.json({ calendar });
  } catch (err) {
    next(err);
  }
});

router.put("/calendars/:calendarId", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const calendarId = requireAnyId(req.params.calendarId, res);
    if (!calendarId) return;

    const input = {
      name: req.body.name,
      description: req.body.description,
      isActive: req.body.isActive,
      timezone: req.body.timezone,
      teamMembers: req.body.teamMembers,
    };

    const calendar = await calendarsClone.updateCalendar(req.tenant.siteId, calendarId, input, locationId);
    if (!calendar) return sendError(res, 404, "Calendario non trovato");
    res.json({ calendar });
  } catch (err) {
    next(err);
  }
});

router.delete("/calendars/:calendarId", async (req, res, next) => {
  try {
    const calendarId = requireAnyId(req.params.calendarId, res);
    if (!calendarId) return;

    const count = await calendarsClone.deleteCalendar(req.tenant.siteId, calendarId);
    if (!count) return sendError(res, 404, "Calendario non trovato");
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Free slots ─────────────────────────────────────────────────────────────

router.get("/calendars/:calendarId/free-slots", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const calendarId = requireAnyId(req.params.calendarId, res);
    if (!calendarId) return;

    const { startDate, endDate } = req.query;
    const result = await calendarsClone.getFreeSlots(req.tenant.siteId, calendarId, startDate, endDate, locationId);
    if (!result) return sendError(res, 404, "Calendario non trovato");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Appuntamenti ─────────────────────────────────────────────────────────

router.get("/appointments", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const result = await calendarsClone.listAppointments(
      req.tenant.siteId,
      {
        calendarId: req.query.calendarId,
        userId: req.query.userId,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        limit,
        startAfterId,
      },
      locationId
    );
    sendList(res, "events", result.events, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.get("/appointments/:eventId", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const eventId = requireAnyId(req.params.eventId, res);
    if (!eventId) return;

    const event = await calendarsClone.getAppointment(req.tenant.siteId, eventId, locationId);
    if (!event) return sendError(res, 404, "Appuntamento non trovato");
    res.json({ event });
  } catch (err) {
    next(err);
  }
});

router.put("/appointments/:eventId", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const eventId = requireAnyId(req.params.eventId, res);
    if (!eventId) return;

    const input = {
      title: req.body.title,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      appointmentStatus: req.body.appointmentStatus || req.body.status,
    };

    const event = await calendarsClone.updateAppointment(req.tenant.siteId, eventId, input, locationId);
    if (!event) return sendError(res, 404, "Appuntamento non trovato");
    res.json({ event });
  } catch (err) {
    next(err);
  }
});

router.delete("/appointments/:eventId", async (req, res, next) => {
  try {
    const eventId = requireAnyId(req.params.eventId, res);
    if (!eventId) return;

    const count = await calendarsClone.deleteAppointment(req.tenant.siteId, eventId);
    if (!count) return sendError(res, 404, "Appuntamento non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;