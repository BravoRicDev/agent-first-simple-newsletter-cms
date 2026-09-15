import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// Route agent per i calendari (multi-agenda) + supporto calendar_id sulle
// route calls esistenti. Usa un token API reale (agent:true) come farebbe
// un'automazione n8n; il modulo call_scheduling va attivato per il sito.
describe("agent: calendari CRUD + calendar_id su calls", () => {
  let site, user, server, baseUrl, token, calendarId, demoCalendarId;

  before(async () => {
    site = await createTestSite("Agent Calendars Test");
    user = await createTestUser(site.id, "admin");
    await query(
      "INSERT INTO site_modules (site_id, module_key, enabled) VALUES ($1, 'call_scheduling', true) ON CONFLICT (site_id, module_key) DO UPDATE SET enabled = true",
      [site.id]
    );
    const created = await createApiToken(user.id, "agent calendars test", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test("GET /calendars senza calendari → lista vuota", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.calendars, []);
  });

  test("POST /calendars crea un calendario (slug derivato dal nome)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Consulenza", description: "Chiamata di consulenza", user_id: user.id }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.calendar.id, "deve restituire il calendario creato");
    assert.equal(body.calendar.slug, "consulenza");
    assert.equal(body.calendar.enabled, true);
    calendarId = body.calendar.id;
  });

  test("POST /calendars con ty_page: crea e salva la pagina di ringraziamento", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Demo", slug: "demo", ty_page: "/grazie-demo" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.calendar.ty_page, "/grazie-demo");
    demoCalendarId = body.calendar.id;
  });

  test("PUT /calendars/:id aggiorna ty_page (e la rimuove con stringa vuota)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars/${calendarId}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Consulenza", ty_page: "/grazie" }),
    });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.calendar.ty_page, "/grazie");

    // stringa vuota → la rimuove
    const clear = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars/${calendarId}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Consulenza", ty_page: "" }),
    });
    assert.equal(clear.status, 200);
    body = await clear.json();
    assert.equal(body.calendar.ty_page, null, "ty_page vuota deve essere rimossa (NULL)");
  });

  test("POST /calendars con slug duplicato → 400", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Altro", slug: "consulenza" }),
    });
    assert.equal(res.status, 400);
  });

  test("GET /calendars ora elenca i calendari con owner_email e ty_page", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.calendars.length, 2);
    const consulenza = body.calendars.find(c => c.id === calendarId);
    const demo = body.calendars.find(c => c.id === demoCalendarId);
    assert.ok(consulenza, "deve esserci il calendario consulenza");
    assert.equal(consulenza.owner_email, user.email);
    assert.equal(demo.ty_page, "/grazie-demo", "la ty_page del calendario demo deve essere presente nella lista");
  });

  test("PUT /calendars/:id aggiorna e disattiva (enabled=false)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars/${calendarId}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Consulenza avanzata", enabled: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.calendar.name, "Consulenza avanzata");
    assert.equal(body.calendar.enabled, false);
  });

  test("PUT /calls/availability con calendar_id → regole per quel calendario, separate dalle generali", async () => {
    // Regole generali (mattina)
    await fetch(`${baseUrl}/api/agent/sites/${site.id}/calls/availability`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [{ weekday: 1, start_time: "09:00", end_time: "12:00", slot_minutes: 30 }] }),
    });
    // Regole del calendario (pomeriggio)
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calls/availability`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [{ weekday: 1, start_time: "14:00", end_time: "18:00", slot_minutes: 30 }], calendar_id: calendarId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rules.length, 1);
    assert.ok(body.rules[0].start_time.startsWith("14:00"), `start_time atteso 14:00, trovato ${body.rules[0].start_time}`);
  });

  test("GET /calls/slots?calendar_id= restituisce slot del calendario (pomeriggio), non generali (mattina)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calls/slots?days=7&calendar_id=${calendarId}`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.slots.length > 0, "ci devono essere slot nei prossimi 7 giorni");
    const hour = new Date(body.slots[0].start).getHours();
    assert.ok(hour >= 14 && hour < 18, `slot del calendario attesi di pomeriggio, trovato ora ${hour}`);
  });

  test("DELETE /calendars/:id elimina (storico scollegato, non cancellato)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars/${calendarId}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/calendars`, { headers: auth() });
    const body = await list.json();
    assert.equal(body.calendars.length, 1, "dopo la delete deve restare solo il calendario demo");
    assert.equal(body.calendars[0].id, demoCalendarId);
    assert.equal(body.calendars[0].ty_page, "/grazie-demo");
  });

  test("route calendari senza modulo attivo → 403", async () => {
    const site2 = await createTestSite("Agent Calendars NoModule");
    const res = await fetch(`${baseUrl}/api/agent/sites/${site2.id}/calendars`, { headers: auth() });
    assert.equal(res.status, 403);
  });
});
