import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { requireModule, isModuleEnabled } from "../middleware/modules.js";
import { resolveSite } from "../middleware/resolve-site.js";
import {
  getAvailabilityRules, setAvailabilityRules, computeAvailableSlots,
  bookCall, cancelCallByToken, listUpcomingCalls,
  scheduleCallManually, setCallOutcome,
  listCalendars, getCalendar, createCalendar, updateCalendar, deleteCalendar,
  listSiteUsers, resolveBookingTarget, listAllCallsForSite,
} from "../services/calls.js";
import { sendMetaCapiEvent, isMarketingConsentGranted } from "../services/tracking.js";

const router = Router();

const bookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: (req, res) => ({ error: res.locals.t("api.forms.tooManyAttempts") }),
  standardHeaders: true, legacyHeaders: false,
});

const WEEKDAYS = [
  { value: 1, label: "Lunedì" }, { value: 2, label: "Martedì" }, { value: 3, label: "Mercoledì" },
  { value: 4, label: "Giovedì" }, { value: 5, label: "Venerdì" }, { value: 6, label: "Sabato" },
  { value: 0, label: "Domenica" },
];

function groupSlotsByDay(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const dayKey = slot.start.toISOString().slice(0, 10);
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey).push(slot);
  }
  return [...groups.entries()].map(([day, daySlots]) => ({ day, slots: daySlots }));
}

// ── Admin ──────────────────────────────────────────────────────────────────

router.get("/admin/calls", requireAuth, authorize("forms", "read"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const calls = await listAllCallsForSite(req.moduleSiteId);
    const calendars = await listCalendars(req.moduleSiteId);
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    res.render("admin/calls/index", { calls, calendars, siteId: req.moduleSiteId, saved: req.query.saved === "1", sites, isSuperadmin });
  } catch (err) { next(err); }
});

// ── Admin: calendari ───────────────────────────────────────────────────────

router.get("/admin/calls/calendars/new", requireAuth, authorize("forms", "create"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const users = await listSiteUsers(isSuperadmin ? null : req.moduleSiteId);
    res.render("admin/calls/calendar-form", { calendar: null, siteId: req.moduleSiteId, sites, isSuperadmin, users, error: null });
  } catch (err) { next(err); }
});

router.post("/admin/calls/calendars", requireAuth, authorize("forms", "create"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const users = await listSiteUsers(isSuperadmin ? null : req.moduleSiteId);
    const body = { name: req.body.name, slug: req.body.slug, description: req.body.description, userId: req.body.user_id || null, enabled: req.body.enabled !== "0", tyPage: req.body.ty_page };
    try {
      await createCalendar(req.moduleSiteId, body);
      res.redirect(`/admin/calls?site_id=${req.moduleSiteId}&saved=1`);
    } catch (err) {
      res.status(400).render("admin/calls/calendar-form", { calendar: body, siteId: req.moduleSiteId, sites, isSuperadmin, users, error: err.message });
    }
  } catch (err) { next(err); }
});

router.get("/admin/calls/calendars/:id/edit", requireAuth, authorize("forms", "update"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const calendar = await getCalendar(req.moduleSiteId, parseInt(req.params.id, 10));
    if (!calendar) return res.status(404).render("error", { message: "Calendario non trovato" });
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const users = await listSiteUsers(isSuperadmin ? null : req.moduleSiteId);
    res.render("admin/calls/calendar-form", { calendar, siteId: req.moduleSiteId, sites, isSuperadmin, users, error: null });
  } catch (err) { next(err); }
});

router.post("/admin/calls/calendars/:id", requireAuth, authorize("forms", "update"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const calendarId = parseInt(req.params.id, 10);
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const users = await listSiteUsers(isSuperadmin ? null : req.moduleSiteId);
    const body = { name: req.body.name, slug: req.body.slug, description: req.body.description, userId: req.body.user_id || null, enabled: req.body.enabled !== "0", tyPage: req.body.ty_page };
    try {
      await updateCalendar(req.moduleSiteId, calendarId, body);
      res.redirect(`/admin/calls?site_id=${req.moduleSiteId}&saved=1`);
    } catch (err) {
      res.status(400).render("admin/calls/calendar-form", { calendar: { id: calendarId, ...body }, siteId: req.moduleSiteId, sites, isSuperadmin, users, error: err.message });
    }
  } catch (err) { next(err); }
});

router.post("/admin/calls/calendars/:id/delete", requireAuth, authorize("forms", "delete"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    await deleteCalendar(req.moduleSiteId, parseInt(req.params.id, 10));
    res.redirect(`/admin/calls?site_id=${req.moduleSiteId}`);
  } catch (err) { next(err); }
});

router.post("/admin/calls/new", requireAuth, authorize("forms", "update"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const start = new Date(req.body.scheduled_at);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || isNaN(start.getTime())) {
      return res.status(400).render("error", { message: "Email o data/ora non validi.", layout: false });
    }
    const calendarId = req.body.calendar_id ? parseInt(req.body.calendar_id, 10) : null;
    if (calendarId && !(await getCalendar(req.moduleSiteId, calendarId))) {
      return res.status(400).render("error", { message: "Calendario non valido.", layout: false });
    }
    await scheduleCallManually(req.moduleSiteId, {
      email, name: req.body.name, start,
      durationMinutes: parseInt(req.body.duration_minutes, 10) || 30,
      createdBy: req.user.sub,
      calendarId,
    });
    res.redirect(`/admin/calls?site_id=${req.moduleSiteId}&saved=1`);
  } catch (err) {
    if (err.message === "slot_taken") {
      return res.status(409).render("error", { message: "Lo slot scelto è già occupato — scegline un altro.", layout: false });
    }
    next(err);
  }
});

router.post("/admin/calls/:id/outcome", requireAuth, authorize("forms", "update"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    await setCallOutcome(req.moduleSiteId, req.params.id, { status: req.body.status, outcomeNotes: req.body.outcome_notes });
    res.redirect(`/admin/calls?site_id=${req.moduleSiteId}&saved=1`);
  } catch (err) { next(err); }
});

router.get("/admin/calls/availability", requireAuth, authorize("forms", "read"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const calendarId = req.query.calendar_id ? parseInt(req.query.calendar_id, 10) : null;
    if (calendarId && !(await getCalendar(req.moduleSiteId, calendarId))) {
      return res.status(404).render("error", { message: "Calendario non trovato" });
    }
    const rules = await getAvailabilityRules(req.moduleSiteId, calendarId);
    const bySite = new Map(rules.map(r => [r.weekday, r]));
    const calendars = await listCalendars(req.moduleSiteId);
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    res.render("admin/calls/availability", { weekdays: WEEKDAYS, rulesByWeekday: bySite, calendars, calendarId, siteId: req.moduleSiteId, saved: req.query.saved === "1", sites, isSuperadmin });
  } catch (err) { next(err); }
});

router.post("/admin/calls/availability", requireAuth, authorize("forms", "update"), requireModule("call_scheduling"), async (req, res, next) => {
  try {
    const calendarId = req.body.calendar_id ? parseInt(req.body.calendar_id, 10) : null;
    if (calendarId && !(await getCalendar(req.moduleSiteId, calendarId))) {
      return res.status(400).render("error", { message: "Calendario non valido.", layout: false });
    }
    const rules = WEEKDAYS
      .filter(w => req.body[`start_${w.value}`] && req.body[`end_${w.value}`])
      .map(w => ({
        weekday: w.value,
        start_time: req.body[`start_${w.value}`],
        end_time: req.body[`end_${w.value}`],
        slot_minutes: req.body[`slot_${w.value}`],
      }));
    await setAvailabilityRules(req.moduleSiteId, rules, calendarId);
    const qs = calendarId ? `&calendar_id=${calendarId}` : "";
    res.redirect(`/admin/calls/availability?site_id=${req.moduleSiteId}${qs}&saved=1`);
  } catch (err) { next(err); }
});

// ── Pubblico ───────────────────────────────────────────────────────────────

// Una richiesta è AJAX se manda l'header X-Requested-With (fetch dei widget)
// o se l'Accept esclude HTML. Stesso pattern di src/routes/forms.js.
function isAjaxRequest(req) {
  if (req.headers["x-requested-with"] === "XMLHttpRequest") return true;
  const accept = String(req.headers["accept"] || "").toLowerCase();
  return accept.includes("application/json");
}

// Stessa validazione di forms.js (isSafeRedirect): solo path relativi che
// non iniziano con // (protocollo relativo) o URL dello stesso host. La
// ty_page del calendario è configurata in admin/agente, ma il redirect
// avviene su una richiesta pubblica → mai fidarsi ciecamente.
function safeTyRedirect(target, req) {
  if (!target) return null;
  const value = String(target).trim();
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    return new URL(value, `${req.protocol}://${req.get("host")}`).host === req.get("host") ? value : null;
  } catch {
    return null;
  }
}

// Carica sito + calendario target (slug esplicito o default) e verifica il
// feature flag. Ritorna { site, calendar } o null (errore già risposto).
async function loadBookingContext(siteId, calendarSlug, res) {
  const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
  if (!site) { res.status(404).render("error", { message: "Sito non trovato", layout: false }); return null; }
  if (!(await isModuleEnabled(siteId, "call_scheduling"))) {
    res.status(404).render("error", { message: "Sito non trovato", layout: false }); return null;
  }
  const calendar = await resolveBookingTarget(siteId, calendarSlug || null);
  if (calendarSlug && !calendar) {
    res.status(404).render("error", { message: "Calendario non trovato", layout: false }); return null;
  }
  return { site, calendar };
}

function renderBookPage(res, site, calendar, slots, { error } = {}) {
  const target = { id: site.id, name: calendar?.name || site.name, slug: calendar?.slug || null, description: calendar?.description || "" };
  const groups = groupSlotsByDay(slots);
  if (error) {
    return res.status(409).render("book/index", { site: target, groups, layout: false, error });
  }
  return res.render("book/index", { site: target, groups, layout: false, error: null });
}

router.get("/book/:siteId", async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const ctx = await loadBookingContext(siteId, null, res);
    if (!ctx) return;
    const slots = await computeAvailableSlots(siteId, { calendarId: ctx.calendar?.id ?? null });
    renderBookPage(res, ctx.site, ctx.calendar, slots);
  } catch (err) { next(err); }
});

router.get("/book/:siteId/:calendarSlug/slots", async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const ctx = await loadBookingContext(siteId, req.params.calendarSlug, res);
    if (!ctx) return;
    const slots = await computeAvailableSlots(siteId, { calendarId: ctx.calendar?.id ?? null });
    res.json({ ok: true, groups: groupSlotsByDay(slots) });
  } catch (err) { next(err); }
});

router.get("/book/:siteId/:calendarSlug", async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const ctx = await loadBookingContext(siteId, req.params.calendarSlug, res);
    if (!ctx) return;
    const slots = await computeAvailableSlots(siteId, { calendarId: ctx.calendar?.id ?? null });
    renderBookPage(res, ctx.site, ctx.calendar, slots);
  } catch (err) { next(err); }
});

// Prenotazione: POST urlencoded classico (pagina /book) o JSON (widget
// {{calendar:slug}} con fetch). La logica è identica: l'email/nome arrivano
// dal body, lo slot deve corrispondere esattamente a uno degli slot calcolati
// ora dal server (mai duration_minutes dal client — DoS sul calendario).
async function handleBooking(req, res) {
  const siteId = parseInt(req.params.siteId, 10);
  const calendarSlug = req.params.calendarSlug || null;
  const ctx = await loadBookingContext(siteId, calendarSlug, res);
  if (!ctx) return;
  const site = ctx.site;
  const calendar = ctx.calendar;
  const calendarId = calendar?.id ?? null;

  if (req.body._honeypot || req.body.website || req.body.url) {
    if (isAjaxRequest(req)) return res.json({ ok: true });
    return renderBookPage(res, site, calendar, [], {});
  }

  const email = String(req.body.email || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const start = new Date(req.body.slot);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || isNaN(start.getTime())) {
    if (isAjaxRequest(req)) return res.status(400).json({ error: "Dati non validi." });
    return res.status(400).render("error", { message: "Dati non validi.", layout: false });
  }

  // duration_minutes NON va preso dal client (form pubblico, nessuna
  // autenticazione): un visitatore potrebbe dichiarare una durata enorme
  // e bloccare il calendario per tutti con una sola richiesta. Lo slot
  // scelto deve corrispondere esattamente a uno di quelli calcolati ora
  // dal server (stesso giro di computeAvailableSlots mostrato in pagina),
  // che porta con sé la durata corretta della regola di disponibilità.
  const currentSlots = await computeAvailableSlots(siteId, { calendarId });
  const matchedSlot = currentSlots.find(s => s.start.getTime() === start.getTime());
  if (!matchedSlot) {
    const slots = await computeAvailableSlots(siteId, { calendarId });
    if (isAjaxRequest(req)) return res.status(409).json({ error: "Questo slot non è più disponibile — scegline un altro." });
    return renderBookPage(res, site, calendar, slots, { error: "Questo slot non è più disponibile — scegline un altro." });
  }

  const result = await bookCall(siteId, { email, name, start, durationMinutes: matchedSlot.duration_minutes, calendarId });
  if (!result.ok) {
    const slots = await computeAvailableSlots(siteId, { calendarId });
    if (isAjaxRequest(req)) return res.status(409).json({ error: "Questo slot è appena stato prenotato da qualcun altro — scegline un altro." });
    return renderBookPage(res, site, calendar, slots, { error: "Questo slot è appena stato prenotato da qualcun altro — scegline un altro." });
  }

  sendMetaCapiEvent(siteId, "Schedule", {
    email, eventSourceUrl: req.headers["referer"], clientIp: req.ip,
    userAgent: req.headers["user-agent"], consentGranted: isMarketingConsentGranted(req),
    dedupKey: result.ok ? result.id : undefined,
  }).catch(() => {});

  if (isAjaxRequest(req)) {
    // Il widget {{calendar:slug}} segue res.data.redirect (window.location);
    // se il calendario ha una ty_page configurata, lì porta il visitatore.
    const redirect = safeTyRedirect(calendar?.ty_page, req);
    return res.json(redirect ? { ok: true, redirect } : { ok: true });
  }
  const redirect = safeTyRedirect(calendar?.ty_page, req);
  if (redirect) return res.redirect(redirect);
  const target = { id: site.id, name: calendar?.name || site.name, slug: calendar?.slug || null };
  res.render("book/confirmed", { site: target, layout: false });
}

router.post("/book/:siteId", bookLimiter, resolveSite, handleBooking);
router.post("/book/:siteId/:calendarSlug", bookLimiter, resolveSite, handleBooking);

router.get("/book/cancel/:token", async (req, res, next) => {
  try {
    res.render("book/cancel", { token: req.params.token, layout: false });
  } catch (err) { next(err); }
});

router.post("/book/cancel/:token", async (req, res, next) => {
  try {
    const cancelled = await cancelCallByToken(req.params.token);
    res.render("book/cancelled", { cancelled, layout: false });
  } catch (err) { next(err); }
});

export default router;
