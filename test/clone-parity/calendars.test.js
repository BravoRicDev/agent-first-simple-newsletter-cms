import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda B: Calendari + Appointments clone API — calendari, appuntamenti, free slots
describe("Onda B — Calendari clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let locationId;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = await res.json();
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Calendars Clone");
    locationId = site.id;
    apiKey = await mkKey(site.id, "test key");

    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  // ── Calendari ────────────────────────────────────────────────────────

  test("Calendario: create (slug auto) → list con meta → get → update teamMembers → delete; 409 slug duplicato", async () => {
    // Create — slug auto dal name
    const createRes = await fetch("/calendars", {
      method: "POST",
      body: JSON.stringify({
        name: "Consulenza",
        description: "Slot per consulenze",
        isActive: true,
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.calendar);
    assert(createRes.data.calendar.id);
    assert.equal(createRes.data.calendar.name, "Consulenza");
    assert.equal(createRes.data.calendar.slug, "consulenza");
    assert.equal(createRes.data.calendar.isActive, true);
    assert(createRes.data.calendar.dateAdded);
    const calendarId = createRes.data.calendar.id;

    // List con meta
    const listRes = await fetch("/calendars");
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.calendars));
    assert(listRes.data.meta);
    assert(typeof listRes.data.meta.total === "number");
    assert.ok(listRes.data.meta.total >= 1);

    // Get
    const getRes = await fetch(`/calendars/${calendarId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.calendar.id, calendarId);
    assert.equal(getRes.data.calendar.name, "Consulenza");

    // 409 slug duplicato
    const dupRes = await fetch("/calendars", {
      method: "POST",
      body: JSON.stringify({
        name: "Altra Consulenza",
        slug: "consulenza",
      }),
    });
    assert.equal(dupRes.status, 409);
    assert(dupRes.data.message);

    // Update teamMembers (se non ci sono user nella fixture OK l'array vuoto)
    const updateRes = await fetch(`/calendars/${calendarId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Consulenza aggiornata",
        teamMembers: [],
      }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.calendar.name, "Consulenza aggiornata");
    assert(Array.isArray(updateRes.data.calendar.teamMembers));

    // Delete — sorgente v3 returns { success: true }
    const deleteRes = await fetch(`/calendars/${calendarId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.ok(deleteRes.data.success === true || deleteRes.data.success === "true");

    // Get after delete → 404
    const notFoundRes = await fetch(`/calendars/${calendarId}`);
    assert.equal(notFoundRes.status, 404);
  });

  // ── Appuntamenti ──────────────────────────────────────────────────────

  test("Appuntamento: create → list filtrata → put status noshow (appointment_status='noshow') → delete (alias legacy)", async () => {
    // Crea calendario
    const calRes = await fetch("/calendars", {
      method: "POST",
      body: JSON.stringify({
        name: "Appuntamenti",
        description: "Test appuntamenti",
      }),
    });
    const calendarId = calRes.data.calendar.id;

    // Create appuntamento — dual-shape: flat + wrapped
    const startTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const endTime = new Date(new Date(startTime).getTime() + 3600 * 1000).toISOString();

    const createRes = await fetch("/calendars/events/appointments", {
      method: "POST",
      body: JSON.stringify({
        calendarId,
        title: "Consulenza cliente",
        startTime,
        endTime,
        email: `contact-${crypto.randomBytes(4).toString("hex")}@test.local`,
      }),
    });
    assert.equal(createRes.status, 201);
    // sorgente flat shape + backward-compat wrapped
    assert(createRes.data.event);
    assert(createRes.data.id || createRes.data.eventId);
    assert(createRes.data.event.id || createRes.data.event.eventId);
    const eventId = createRes.data.event.id || createRes.data.event.eventId;
    assert.equal(createRes.data.event.title, "Consulenza cliente");
    assert.equal(createRes.data.event.appointmentStatus || createRes.data.event.status, "confirmed");
    // flat shape also present
    assert.equal(createRes.data.title, "Consulenza cliente");

    // List filtrata per calendario (alias legacy)
    const listRes = await fetch(`/appointments?calendarId=${calendarId}`);
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.events));
    assert(listRes.data.meta);
    const found = listRes.data.events.find((e) => (e.id || e.eventId) === eventId);
    assert(found);

    // Put status noshow (alias legacy — wrapped response)
    const updateRes = await fetch(`/appointments/${eventId}`, {
      method: "PUT",
      body: JSON.stringify({
        status: "noshow",
      }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.event.appointmentStatus || updateRes.data.event.status, "noshow");

    // Delete (alias legacy — { deleted: true })
    const deleteRes = await fetch(`/appointments/${eventId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);

    // Get after delete → 404
    const notFoundRes = await fetch(`/appointments/${eventId}`);
    assert.equal(notFoundRes.status, 404);
  });

  test("Appuntamento sorgente v3: GET /calendars/events, GET/PUT/DELETE /calendars/events/appointments/:id", async () => {
    // Crea calendario
    const calRes = await fetch("/calendars", {
      method: "POST",
      body: JSON.stringify({ name: "sorgente v3 appt", description: "v3 test" }),
    });
    const calendarId = calRes.data.calendar.id;

    const startTime = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const endTime = new Date(new Date(startTime).getTime() + 3600 * 1000).toISOString();

    const createRes = await fetch("/calendars/events/appointments", {
      method: "POST",
      body: JSON.stringify({
        calendarId,
        title: "sorgente v3 event",
        startTime,
        endTime,
        email: `sourcev3-${crypto.randomBytes(4).toString("hex")}@test.local`,
      }),
    });
    assert.equal(createRes.status, 201);
    const eventId = createRes.data.id || createRes.data.event.id;
    assert.ok(eventId);

    // sorgente v3: GET /calendars/events with millis startTime/endTime
    const startMillis = Date.now() - 24 * 3600 * 1000;
    const endMillis = Date.now() + 7 * 24 * 3600 * 1000;
    const listRes = await fetch(`/calendars/events?calendarId=${calendarId}&startTime=${startMillis}&endTime=${endMillis}`);
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.events));
    const found = listRes.data.events.find((e) => (e.id || e.eventId) === eventId);
    assert(found, "evento creato deve comparire in GET /calendars/events");

    // sorgente v3: GET /calendars/events/appointments/:eventId — wrapped { event }
    const getRes = await fetch(`/calendars/events/appointments/${eventId}`);
    assert.equal(getRes.status, 200);
    assert(getRes.data.event);
    assert.equal(getRes.data.event.id || getRes.data.event.eventId, eventId);
    assert.equal(getRes.data.event.title, "sorgente v3 event");

    // sorgente v3: PUT /calendars/events/appointments/:eventId — flat response, appointmentStatus
    const updateRes = await fetch(`/calendars/events/appointments/${eventId}`, {
      method: "PUT",
      body: JSON.stringify({ appointmentStatus: "noshow" }),
    });
    assert.equal(updateRes.status, 200);
    // flat response (no wrapper)
    assert.equal(updateRes.data.appointmentStatus || updateRes.data.status, "noshow");
    assert.equal(updateRes.data.id || updateRes.data.eventId, eventId);

    // sorgente v3: DELETE /calendars/events/appointments/:eventId — { succeeded: true } 201
    const deleteRes = await fetch(`/calendars/events/appointments/${eventId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 201);
    assert.equal(deleteRes.data.succeeded, true);

    // Get after delete → 404
    const notFoundRes = await fetch(`/calendars/events/appointments/${eventId}`);
    assert.equal(notFoundRes.status, 404);
  });

  // ── Free slots ────────────────────────────────────────────────────────

  test("Free-slots: shape sorgente { YYYY-MM-DD: { slots: [ISOstring] } }", async () => {
    // Crea calendario
    const calRes = await fetch("/calendars", {
      method: "POST",
      body: JSON.stringify({
        name: "Disponibilità",
        description: "Slot liberi",
      }),
    });
    const calendarId = calRes.data.calendar.id;

    // Get free slots — sorgente shape
    const slotsRes = await fetch(`/calendars/${calendarId}/free-slots?startDate=2026-08-26&endDate=2026-08-31`);
    assert.equal(slotsRes.status, 200);
    // sorgente returns date-keyed object at top level, e.g. { "2026-08-27": { slots: [...] } }
    assert.equal(typeof slotsRes.data, "object");
    assert.ok(slotsRes.data !== null);

    // Se ci sono slot, verifica shape sorgente
    const dateKeys = Object.keys(slotsRes.data).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
    for (const date of dateKeys) {
      const entry = slotsRes.data[date];
      assert.ok(entry && typeof entry === "object", `entry per ${date} deve essere oggetto`);
      assert.ok(Array.isArray(entry.slots), `slots per ${date} deve essere array`);
      for (const slot of entry.slots) {
        assert.equal(typeof slot, "string", "ogni slot deve essere stringa ISO");
        assert.ok(!isNaN(Date.parse(slot)), `slot "${slot}" deve essere ISO date valida`);
      }
    }
  });

  // ── Validazione ID ────────────────────────────────────────────────────

  test("400 per ID palesemente malformato (vuoto o >255 char) in path", async () => {
    // ID vuoto: route /calendars/ → 404 (Express non matcha), ma possiamo testare
    // ID >255 char → 400
    const tooLong = "x".repeat(256);
    const tooLongRes = await fetch(`/calendars/${tooLong}`);
    assert.equal(tooLongRes.status, 400);
    assert.equal(tooLongRes.data.statusCode, 400);
    assert(tooLongRes.data.message.includes("non valido") || tooLongRes.data.message.includes("valido"));
  });

  test("404 per ID formato valido ma inesistente in path", async () => {
    // UUID valido che non esiste
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    const notFoundRes = await fetch(`/calendars/${fakeUuid}`);
    assert.equal(notFoundRes.status, 404);
    assert(notFoundRes.data.message);

    // Stringa alfanumerica stile sorgente che non esiste
    const fakeSourceId = "eMjqNVexkS7CyIM2qdtg";
    const notFoundRes2 = await fetch(`/calendars/${fakeSourceId}`);
    assert.equal(notFoundRes2.status, 404);
    assert(notFoundRes2.data.message);
  });
});