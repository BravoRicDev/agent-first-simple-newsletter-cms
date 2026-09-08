import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireUuid, getPaging, sendList, getLocationId,
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
    res.status(201).json({ event });
  } catch (err) {
    next(err);
  }
});

router.get("/calendars/:calendarId", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const calendarId = requireUuid(req.params.calendarId, res);
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
    const calendarId = requireUuid(req.params.calendarId, res);
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
    const calendarId = requireUuid(req.params.calendarId, res);
    if (!calendarId) return;

    const count = await calendarsClone.deleteCalendar(req.tenant.siteId, calendarId);
    if (!count) return sendError(res, 404, "Calendario non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ── Free slots (statico PRIMA di :calendarId) ─────────────────────────────

router.get("/calendars/:calendarId/free-slots", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const calendarId = requireUuid(req.params.calendarId, res);
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
    const eventId = requireUuid(req.params.eventId, res);
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
    const eventId = requireUuid(req.params.eventId, res);
    if (!eventId) return;

    const input = {
      title: req.body.title,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      status: req.body.status,
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
    const eventId = requireUuid(req.params.eventId, res);
    if (!eventId) return;

    const count = await calendarsClone.deleteAppointment(req.tenant.siteId, eventId);
    if (!count) return sendError(res, 404, "Appuntamento non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
