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

    // Delete
    const deleteRes = await fetch(`/calendars/${calendarId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);

    // Get after delete → 404
    const notFoundRes = await fetch(`/calendars/${calendarId}`);
    assert.equal(notFoundRes.status, 404);
  });

  // ── Appuntamenti ──────────────────────────────────────────────────────

  test("Appuntamento: create → list filtrata → put status noshow (appointment_status='noshow') → delete", async () => {
    // Crea calendario
    const calRes = await fetch("/calendars", {
      method: "POST",
      body: JSON.stringify({
        name: "Appuntamenti",
        description: "Test appuntamenti",
      }),
    });
    const calendarId = calRes.data.calendar.id;

    // Create appuntamento
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
    assert(createRes.data.event);
    assert(createRes.data.event.eventId);
    assert.equal(createRes.data.event.title, "Consulenza cliente");
    assert.equal(createRes.data.event.status, "confirmed");
    const eventId = createRes.data.event.eventId;

    // List filtrata per calendario
    const listRes = await fetch(`/appointments?calendarId=${calendarId}`);
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.events));
    assert(listRes.data.meta);
    const found = listRes.data.events.find((e) => e.eventId === eventId);
    assert(found);

    // Put status noshow
    const updateRes = await fetch(`/appointments/${eventId}`, {
      method: "PUT",
      body: JSON.stringify({
        status: "noshow",
      }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.event.status, "noshow");

    // Delete
    const deleteRes = await fetch(`/appointments/${eventId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);

    // Get after delete → 404
    const notFoundRes = await fetch(`/appointments/${eventId}`);
    assert.equal(notFoundRes.status, 404);
  });

  // ── Free slots ────────────────────────────────────────────────────────

  test("Free-slots: shape per-data con slotIntervals", async () => {
    // Crea calendario
    const calRes = await fetch("/calendars", {
      method: "POST",
      body: JSON.stringify({
        name: "Disponibilità",
        description: "Slot liberi",
      }),
    });
    const calendarId = calRes.data.calendar.id;

    // Get free slots
    const slotsRes = await fetch(`/calendars/${calendarId}/free-slots?startDate=2026-08-26&endDate=2026-08-31`);
    assert.equal(slotsRes.status, 200);
    assert(slotsRes.data.slots);
    assert(typeof slotsRes.data.slots === "object");

    // Verifica shape: data → array di {openHour, openMinute, closeHour, closeMinute, slotIntervals}
    for (const [date, dateSlots] of Object.entries(slotsRes.data.slots)) {
      assert(typeof date === "string");
      assert(Array.isArray(dateSlots));
      for (const slot of dateSlots) {
        assert(typeof slot.openHour === "number");
        assert(typeof slot.openMinute === "number");
        assert(typeof slot.closeHour === "number");
        assert(typeof slot.closeMinute === "number");
        assert(Array.isArray(slot.slotIntervals));
        for (const interval of slot.slotIntervals) {
          assert(typeof interval.startTime === "string");
          assert(typeof interval.endTime === "string");
        }
      }
    }
  });

  // ── UUID validation ───────────────────────────────────────────────────

  test("400 UUID invalido in path", async () => {
    const badRes = await fetch("/calendars/not-a-uuid");
    assert.equal(badRes.status, 400);
    assert(badRes.data.statusCode === 400);
  });
});
