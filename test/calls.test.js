// Richiede una Postgres di test raggiungibile via DATABASE_URL (stessa
// variabile usata dall'app), con le migrazioni già applicate — "npm test"
// lo fa da solo (vedi package.json). Esempio rapido con Docker:
//   docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb -p 15999:5432 postgres:16-alpine
//   DATABASE_URL=postgres://postgres:test@localhost:15999/testdb npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { setAvailabilityRules, computeAvailableSlots, bookCall } from "../src/services/calls.js";
import callsRouter from "../src/routes/calls.js";

describe("calls: disponibilità, prenotazione, sicurezza slot", () => {
  let site, server, baseUrl;

  before(async () => {
    site = await createTestSite("Calls Test");
    // Public booking respects the call_scheduling feature flag;
    // the test site must have it enabled (gated in the booking routes).
    await query(
      "INSERT INTO site_modules (site_id, module_key, enabled) VALUES ($1, 'call_scheduling', true) ON CONFLICT (site_id, module_key) DO UPDATE SET enabled = true",
      [site.id]
    );
    await setAvailabilityRules(site.id, [0, 1, 2, 3, 4, 5, 6].map(weekday => ({
      weekday, start_time: "09:00", end_time: "17:00", slot_minutes: 30,
    })));

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", new URL("../views", import.meta.url).pathname);
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(callsRouter);

    await new Promise(resolve => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server.close();
    await closeDb();
  });

  test("computeAvailableSlots genera slot futuri secondo le regole", async () => {
    const slots = await computeAvailableSlots(site.id, { days: 2 });
    assert.ok(slots.length > 0, "dovrebbero esserci slot liberi");
    assert.ok(slots.every(s => s.duration_minutes === 30));
    assert.ok(slots.every(s => s.start.getTime() > Date.now()), "nessuno slot nel passato");
  });

  test("prenotare uno slot lo rimuove dai disponibili, e impedisce doppie prenotazioni", async () => {
    const slots = await computeAvailableSlots(site.id, { days: 3 });
    const target = slots[0];

    const first = await bookCall(site.id, { email: "primo@example.test", start: target.start, durationMinutes: 30, notify: false });
    assert.equal(first.ok, true);

    const second = await bookCall(site.id, { email: "secondo@example.test", start: target.start, durationMinutes: 30, notify: false });
    assert.equal(second.ok, false, "lo stesso slot non deve poter essere prenotato due volte");

    const after = await computeAvailableSlots(site.id, { days: 3 });
    assert.ok(!after.some(s => s.start.getTime() === target.start.getTime()), "lo slot prenotato non deve più comparire come libero");
  });

  test("SICUREZZA: la prenotazione pubblica ignora duration_minutes forgiato dal client (DoS sul calendario)", async () => {
    const slots = await computeAvailableSlots(site.id, { days: 5 });
    const target = slots[0];

    const res = await fetch(`${baseUrl}/book/${site.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Attaccante", email: "attaccante@example.test",
        slot: target.start.toISOString(),
        duration_minutes: String(7 * 24 * 60), // 7 giorni: tenta di bloccare il calendario
      }),
    });
    assert.equal(res.status, 200);

    const stored = (await query(
      "SELECT duration_minutes FROM calls WHERE site_id = $1 AND email = 'attaccante@example.test'",
      [site.id]
    )).rows[0];
    assert.equal(stored.duration_minutes, 30, "la durata salvata deve essere quella della regola (30), mai quella dichiarata dal client");
  });

  test("SICUREZZA: la prenotazione pubblica rifiuta uno slot non allineato a nessuna regola", async () => {
    const bogus = new Date();
    bogus.setDate(bogus.getDate() + 1);
    bogus.setHours(3, 17, 0, 0); // fuori da qualunque fascia oraria configurata (09:00-17:00)

    const res = await fetch(`${baseUrl}/book/${site.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Bogus", email: "bogus@example.test", slot: bogus.toISOString(), duration_minutes: "30" }),
    });
    assert.equal(res.status, 409);

    const rows = (await query("SELECT 1 FROM calls WHERE site_id = $1 AND email = 'bogus@example.test'", [site.id])).rows;
    assert.equal(rows.length, 0, "non deve essere stata creata nessuna riga");
  });

  test("honeypot compilato: risponde ok ma non prenota nulla", async () => {
    const slots = await computeAvailableSlots(site.id, { days: 6 });
    const target = slots[slots.length - 1];

    await fetch(`${baseUrl}/book/${site.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Bot", email: "bot@example.test", slot: target.start.toISOString(), _honeypot: "spam" }),
    });

    const rows = (await query("SELECT 1 FROM calls WHERE site_id = $1 AND email = 'bot@example.test'", [site.id])).rows;
    assert.equal(rows.length, 0);
  });
});
