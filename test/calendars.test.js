import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import {
  createCalendar, setAvailabilityRules, computeAvailableSlots, bookCall,
} from "../src/services/calls.js";
import { expandSnippets } from "../src/services/page-renderer.js";
import callsRouter from "../src/routes/calls.js";

// Multi-calendario: ogni calendario ha la propria disponibilità, le proprie
// prenotazioni e si integra nelle pagine con {{calendar:slug}} (widget).
describe("calendari: disponibilità per calendario, indipendenza slot, widget snippet", () => {
  let site, server, baseUrl, calendar, calendar2;

  before(async () => {
    site = await createTestSite("Calendars Test");
    await query(
      "INSERT INTO site_modules (site_id, module_key, enabled) VALUES ($1, 'call_scheduling', true) ON CONFLICT (site_id, module_key) DO UPDATE SET enabled = true",
      [site.id]
    );
    // Regole "generali" (site-wide, legacy): solo la mattina.
    await setAvailabilityRules(site.id, [1, 2, 3, 4, 5].map(weekday => ({
      weekday, start_time: "09:00", end_time: "12:00", slot_minutes: 30,
    })));

    // Due calendari con disponibilità diverse.
    calendar = await createCalendar(site.id, { name: "Consulenza", slug: "consulenza", description: "Chiamata di consulenza" });
    await setAvailabilityRules(site.id, [1, 2, 3, 4, 5].map(weekday => ({
      weekday, start_time: "14:00", end_time: "18:00", slot_minutes: 30,
    })), calendar);
    calendar2 = await createCalendar(site.id, { name: "Demo", slug: "demo" });

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

  test("ogni calendario usa le proprie regole (pomeriggio) e NON quelle generali (mattina)", async () => {
    const general = await computeAvailableSlots(site.id, { days: 7 });
    const consulenza = await computeAvailableSlots(site.id, { days: 7, calendarId: calendar });
    assert.ok(general.length > 0, "ci devono essere slot generali nei prossimi 7 giorni");
    assert.ok(consulenza.length > 0, "ci devono essere slot consulenza nei prossimi 7 giorni");
    const gHour = new Date(general[0].start).getHours();
    const cHour = new Date(consulenza[0].start).getHours();
    assert.ok(gHour >= 9 && gHour < 12, `slot generali attesi di mattina, trovato ora ${gHour}`);
    assert.ok(cHour >= 14 && cHour < 18, `slot consulenza attesi di pomeriggio, trovato ora ${cHour}`);
  });

  test("lo stesso orario è prenotabile su calendari diversi (indipendenza)", async () => {
    const slots = await computeAvailableSlots(site.id, { days: 7, calendarId: calendar });
    const target = slots[0];

    const a = await bookCall(site.id, { email: "a@example.test", start: target.start, durationMinutes: 30, notify: false, calendarId: calendar });
    assert.equal(a.ok, true, "prima prenotazione sul calendario 1 deve riuscire");

    const b = await bookCall(site.id, { email: "b@example.test", start: target.start, durationMinutes: 30, notify: false, calendarId: calendar2 });
    assert.equal(b.ok, true, "lo stesso orario sul calendario 2 deve riuscire (calendari indipendenti)");

    const dup = await bookCall(site.id, { email: "c@example.test", start: target.start, durationMinutes: 30, notify: false, calendarId: calendar });
    assert.equal(dup.ok, false, "doppia prenotazione sullo STESSO calendario deve fallire");
  });

  test("GET /book/:siteId/:slug/slots restituisce gli slot del calendario in JSON", async () => {
    const res = await fetch(`${baseUrl}/book/${site.id}/consulenza/slots`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.groups), "groups deve essere un array");
    assert.ok(body.groups.length > 0, "ci devono essere slot disponibili");
  });

  test("POST AJAX su /book/:siteId/:slug prenota e risponde JSON", async () => {
    const slots = await computeAvailableSlots(site.id, { days: 4, calendarId: calendar });
    const target = slots[0];
    const res = await fetch(`${baseUrl}/book/${site.id}/consulenza`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams({ name: "Widget User", email: "widget@example.test", slot: target.start.toISOString() }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    const row = (await query(
      "SELECT calendar_id FROM calls WHERE site_id = $1 AND email = 'widget@example.test'",
      [site.id]
    )).rows[0];
    assert.equal(row.calendar_id, calendar, "la chiamata deve essere associata al calendario giusto");
  });

  test("{{calendar:slug}} si espande in un widget autonomo (e uno slug inesistente resta invariato)", async () => {
    const html = await expandSnippets(site.id, "<p>{{calendar:consulenza}}</p><p>{{calendar:inesistente}}</p>");
    assert.ok(html.includes('class="cms-calendar"'), "deve esserci il widget");
    assert.ok(html.includes(`data-site="${site.id}"`), "il widget deve puntare al sito giusto");
    assert.ok(html.includes('data-slug="consulenza"'), "il widget deve puntare allo slug giusto");
    assert.ok(html.includes("endpoint + '/slots'"), "il widget deve caricare gli slot via /slots");
    assert.ok(html.includes("{{calendar:inesistente}}"), "uno slug inesistente NON deve essere sostituito");
  });

  test("il JS del widget NON deve contenere apostrofi escaped dentro single-quote (bug export 2026-08)", async () => {
    const html = await expandSnippets(site.id, "<p>{{calendar:consulenza}}</p>");
    // Bug reale: 'Prenotazione confermata! Riceverai un\\'email di conferma.'
    // dentro una template literal → backslash consumato → setMsg('...un'email...')
    // → SyntaxError → widget rotto → \"Caricamento disponibilità…\" per sempre.
    assert.ok(
      html.includes('setMsg("Prenotazione confermata! Riceverai un\'email di conferma.");'),
      "il messaggio di conferma deve usare doppi apici (apostrofo dentro single-quote sarebbe rotto)"
    );
    assert.ok(!html.includes("un\\'email"), "non deve esserci l'escape \\' (consumato dall'export)");
  });

  test("widget di un calendario disattivato NON viene espanso", async () => {
    await query("UPDATE calendars SET enabled = false WHERE id = $1", [calendar2]);
    const html = await expandSnippets(site.id, "<p>{{calendar:demo}}</p>");
    assert.ok(html.includes("{{calendar:demo}}"), "il calendario disattivato deve restare come placeholder");
    await query("UPDATE calendars SET enabled = true WHERE id = $1", [calendar2]);
  });

  test("ty_page configurata: booking AJAX risponde con redirect, booking classico fa 302", async () => {
    await query("UPDATE calendars SET ty_page = '/grazie' WHERE id = $1", [calendar]);
    try {
      // AJAX (widget): il JSON deve contenere redirect
      const slots = await computeAvailableSlots(site.id, { days: 4, calendarId: calendar });
      const target = slots[0];
      const res = await fetch(`${baseUrl}/book/${site.id}/consulenza`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ name: "TY User", email: "ty-ajax@example.test", slot: target.start.toISOString() }),
        redirect: "manual",
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.redirect, "/grazie", "AJAX deve ricevere la ty_page nel campo redirect");

      // Classico (browser): 302 verso la ty_page
      const slots2 = await computeAvailableSlots(site.id, { days: 4, calendarId: calendar });
      const target2 = slots2[0];
      const res2 = await fetch(`${baseUrl}/book/${site.id}/consulenza`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "TY Browser", email: "ty-browser@example.test", slot: target2.start.toISOString() }),
        redirect: "manual",
      });
      assert.equal(res2.status, 302, "il booking classico deve fare un redirect");
      assert.equal(res2.headers.get("location"), "/grazie", "la Location deve essere la ty_page");
    } finally {
      await query("UPDATE calendars SET ty_page = NULL WHERE id = $1", [calendar]);
    }
  });

  test("ty_page con dominio esterno viene ignorata (sicurezza)", async () => {
    await query("UPDATE calendars SET ty_page = 'https://evil.example.com/phish' WHERE id = $1", [calendar]);
    try {
      const slots = await computeAvailableSlots(site.id, { days: 4, calendarId: calendar });
      const target = slots[0];
      const res = await fetch(`${baseUrl}/book/${site.id}/consulenza`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ name: "TY Safe", email: "ty-safe@example.test", slot: target.start.toISOString() }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.redirect, undefined, "un redirect verso dominio esterno NON deve essere seguito");
    } finally {
      await query("UPDATE calendars SET ty_page = NULL WHERE id = $1", [calendar]);
    }
  });
});
