import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import v1Routes from "../src/routes/v1.js";
import { query } from "../src/db.js";
import { closeDb, createTestSite } from "./helpers.js";
import crypto from "crypto";

// ONDA 2 — booking calendar sync: config CRUD e verifica che il sync
// calendario sia fire-and-forget (mai blocca il booking, mai errore 500).
//
// I test di sincronizzazione reale verso Google Calendar NON sono possibili
// senza credenziali OAuth effettive (decisione umana: configurabile per tenant,
// non hardcoded). I test qui verificano:
//
// 1. Il booking funziona NORMALMENTE senza alcuna config calendar
// 2. La CRUD della config "/v1/booking-calendar-config" è operativa
// 3. Con una OAuth connection fittizia ma non attiva, il booking crea/cancella
//    senza errori (sync gracefully skipped)
describe("ONDA 2 — booking calendar sync", () => {
  let server, baseUrl;
  let siteA, siteB, apiKeyA;

  before(async () => {
    // Pulisci booking del tenant
    await query("DELETE FROM booking_appointments WHERE site_id IN (SELECT id FROM sites ORDER BY id DESC LIMIT 5)");
    await query("DELETE FROM booking_calendar_config WHERE site_id IN (SELECT id FROM sites ORDER BY id DESC LIMIT 5)");

    // Crea sito di test
    siteA = await createTestSite();

    // API key per-tenant
    const tokenA = crypto.randomBytes(32).toString("hex");
    const hashA = crypto.createHash("sha256").update(tokenA).digest("hex");
    await query(
      `INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active)
       VALUES ($1, $2, $3, $4, true)`,
      [siteA.id, "test-key-A", hashA, tokenA.slice(0, 8)]
    );
    apiKeyA = tokenA;

    // App di test
    const app = express();
    app.use(express.json());
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      console.error("TEST ERROR:", err.message, err.stack?.slice(0, 300));
      res.status(err.statusCode || 500).json({ error: err.message });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await query("DELETE FROM booking_calendar_config WHERE site_id = $1", [siteA.id]);
    await query("DELETE FROM booking_appointments WHERE site_id = $1", [siteA.id]);
    await closeDb();
  });

  function headers(apiKey, loc) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Location-Id": String(loc || siteA.id),
      accept: "application/json",
    };
  }

  test("booking funziona senza calendar config (fire-and-forget skip)", async () => {
    const start = new Date(Date.now() + 86400000).toISOString();
    const res = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({
        contact_name: "No Calendar",
        contact_email: "nocal@prova.com",
        title: "Senza config calendario",
        start_time: start,
      }),
    });
    const r = await res.json();
    assert.equal(res.status, 201, `POST senza config: ${JSON.stringify(r)}`);
    assert.ok(r.booking?.id > 0);
    // Nessun google_event_id perché nessuna config attiva
    assert.equal(r.booking.google_event_id, null);

    // Cancella
    const resDel = await fetch(`${baseUrl}/v1/bookings/${r.booking.id}`, {
      method: "DELETE",
      headers: headers(apiKeyA),
    });
    assert.equal(resDel.status, 200);
    // Cancellazione senza google_event_id non tenta GC → OK
  });

  test("booking-calendar-config CRUD: GET vuota, POST, GET, PUT, DELETE", async () => {
    // GET iniziale → null
    const res0 = await fetch(`${baseUrl}/v1/booking-calendar-config`, { headers: headers(apiKeyA) });
    const r0 = await res0.json();
    assert.equal(res0.status, 200);
    assert.equal(r0.config, null);

    // Crea una OAuth app + connection fittizia per testare la config
    const fakeApp = await query(
      `INSERT INTO oauth_apps (site_id, provider, client_id, client_secret, redirect_uri, enabled)
       VALUES ($1, 'google', 'test-client-id', 'test-secret', 'http://localhost/callback', true) RETURNING id`,
      [siteA.id]
    );
    const fakeAppId = fakeApp.rows[0].id;

    const fakeConn = await query(
      `INSERT INTO oauth_connections (site_id, app_id, provider, access_token, refresh_token, active)
       VALUES ($1, $2, 'google', 'fake-token', 'fake-refresh', true) RETURNING id`,
      [siteA.id, fakeAppId]
    );
    const fakeConnId = fakeConn.rows[0].id;

    // POST: crea config con quella connessione
    const res1 = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({
        oauth_connection_id: fakeConnId,
        calendar_id: "primary",
      }),
    });
    const r1 = await res1.json();
    assert.equal(res1.status, 201, `POST config: ${JSON.stringify(r1)}`);
    assert.ok(r1.config?.id > 0);
    assert.equal(r1.config.oauth_connection_id, fakeConnId);
    assert.equal(r1.config.active, true);

    // GET config dopo POST → la trova
    const res2 = await fetch(`${baseUrl}/v1/booking-calendar-config`, { headers: headers(apiKeyA) });
    const r2 = await res2.json();
    assert.equal(res2.status, 200);
    assert.ok(r2.config, `GET config dopo POST: ${JSON.stringify(r2)}`);
    assert.equal(r2.config.id, r1.config.id);

    // PUT: aggiorna calendar_id
    const res3 = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "PUT",
      headers: headers(apiKeyA),
      body: JSON.stringify({ calendar_id: "secondario@group.calendar.google.com" }),
    });
    const r3 = await res3.json();
    assert.equal(res3.status, 200, `PUT config: ${JSON.stringify(r3)}`);
    assert.equal(r3.config.calendar_id, "secondario@group.calendar.google.com");

    // DELETE: disattiva config
    const res4 = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "DELETE",
      headers: headers(apiKeyA),
    });
    const r4 = await res4.json();
    assert.equal(res4.status, 200, `DELETE config: ${JSON.stringify(r4)}`);
    assert.equal(r4.deleted, true);

    // GET dopo DELETE → null
    const res5 = await fetch(`${baseUrl}/v1/booking-calendar-config`, { headers: headers(apiKeyA) });
    const r5 = await res5.json();
    assert.equal(res5.status, 200);
    assert.equal(r5.config, null);

    // Pulisci connessione e app fittizia
    await query("DELETE FROM oauth_connections WHERE id = $1", [fakeConnId]);
    await query("DELETE FROM oauth_apps WHERE id = $1", [fakeAppId]);
  });

  test("booking funziona con config ma senza OAuth reale (graceful skip Google Calendar)", async () => {
    // Crea una OAuth connection con token finto ma active=false
    // (simula il caso in cui l'OAuth non è attivo / credenziali mancanti)
    // getBookingCalendarConfig verifica active=true E access_token non vuoto
    // → rifiuta la connessione → tryCreateEvent esce senza errori
    // Crea una OAuth app + connection fittizia con active=false per simulare
    // il caso in cui l'OAuth non è attivo / credenziali mancanti
    const disabledApp = await query(
      `INSERT INTO oauth_apps (site_id, provider, client_id, client_secret, redirect_uri, enabled)
       VALUES ($1, 'google', 'test-client-id-2', 'test-secret-2', 'http://localhost/callback', true) RETURNING id`,
      [siteA.id]
    );
    const disabledAppId = disabledApp.rows[0].id;

    const disabledConn = await query(
      `INSERT INTO oauth_connections (site_id, app_id, provider, access_token, refresh_token, active)
       VALUES ($1, $2, 'google', '', '', false) RETURNING id`,
      [siteA.id, disabledAppId]
    );
    const disabledId = disabledConn.rows[0].id;

    // Config con connessione disabilitata
    const resCfg = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({ oauth_connection_id: disabledId }),
    });
    const cfg = await resCfg.json();
    assert.equal(resCfg.status, 201);

    // Crea booking — deve funzionare normalissimo (nessun tentativo verso Google)
    const start = new Date(Date.now() + 86400000).toISOString();
    const resB = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({
        contact_name: "Graceful Skip",
        contact_email: "gskip@prova.com",
        title: "Sync gracefully skipped",
        start_time: start,
      }),
    });
    const b = await resB.json();
    assert.equal(resB.status, 201, `POST con config$OAuth: ${JSON.stringify(b)}`);
    assert.ok(b.booking?.id > 0);
    // google_event_id rimane null perché il sync è stato skipato
    assert.equal(b.booking.google_event_id, null);

    // Cancella — nessun errore
    const resDel = await fetch(`${baseUrl}/v1/bookings/${b.booking.id}`, {
      method: "DELETE",
      headers: headers(apiKeyA),
    });
    assert.equal(resDel.status, 200);

    // Pulisci
    await query("DELETE FROM booking_calendar_config WHERE site_id = $1", [siteA.id]);
    await query("DELETE FROM oauth_connections WHERE id = $1", [disabledId]);
    await query("DELETE FROM oauth_apps WHERE id = $1", [disabledAppId]);
  });

  test("booking-calendar-config: 400 su POST senza oauth_connection_id", async () => {
    const res = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({ calendar_id: "primary" }),
    });
    assert.equal(res.status, 400);
  });

  test("booking-calendar-config: 404 su DELETE senza config attiva", async () => {
    const res = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "DELETE",
      headers: headers(apiKeyA),
    });
    assert.equal(res.status, 404);
  });

  test("booking-calendar-config: 404 su PUT senza config attiva", async () => {
    const res = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "PUT",
      headers: headers(apiKeyA),
      body: JSON.stringify({ calendar_id: "test" }),
    });
    assert.equal(res.status, 404);
  });

  test("booking update con google_event_id ma senza config → graceful skip", async () => {
    // Crea booking senza config calendar
    const start = new Date(Date.now() + 86400000).toISOString();
    const res1 = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({
        contact_name: "Update No Config",
        contact_email: "upd.noconfig@prova.com",
        title: "Update senza config",
        start_time: start,
      }),
    });
    const r1 = await res1.json();
    assert.equal(res1.status, 201);
    const bookingId = r1.booking.id;

    // Forza google_event_id via UPDATE diretto SQL (simula booking con evento GC esistente)
    await query(
      "UPDATE booking_appointments SET google_event_id = $1 WHERE id = $2",
      ["fake-google-event-id-upd", bookingId]
    );

    // PUT booking: cambia title — nessuna config attiva → tryUpdateEvent skipa
    const res2 = await fetch(`${baseUrl}/v1/bookings/${bookingId}`, {
      method: "PUT",
      headers: headers(apiKeyA),
      body: JSON.stringify({ title: "Update senza config — aggiornato" }),
    });
    assert.equal(res2.status, 200, `PUT dopo google_event_id senza config: ${res2.status}`);
    const r2 = await res2.json();
    assert.equal(r2.booking.title, "Update senza config — aggiornato");

    // Pulisci
    await query("DELETE FROM booking_appointments WHERE id = $1", [bookingId]);
  });

  test("booking update con google_event_id e config attiva ma OAuth fittizio → graceful skip", async () => {
    // Crea OAuth app + connection attiva ma token finto (non valido per Google)
    const fakeApp = await query(
      `INSERT INTO oauth_apps (site_id, provider, client_id, client_secret, redirect_uri, enabled)
       VALUES ($1, 'google', 'test-oauth-upd', 'test-secret-upd', 'http://localhost/callback', true) RETURNING id`,
      [siteA.id]
    );
    const fakeAppId = fakeApp.rows[0].id;

    const fakeConn = await query(
      `INSERT INTO oauth_connections (site_id, app_id, provider, access_token, refresh_token, active)
       VALUES ($1, $2, 'google', 'fake-token-update', 'fake-refresh-update', true) RETURNING id`,
      [siteA.id, fakeAppId]
    );
    const fakeConnId = fakeConn.rows[0].id;

    // Config con connessione attiva
    const resCfg = await fetch(`${baseUrl}/v1/booking-calendar-config`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({ oauth_connection_id: fakeConnId }),
    });
    assert.equal(resCfg.status, 201);

    // Crea booking
    const start = new Date(Date.now() + 86400000).toISOString();
    const resB = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({
        contact_name: "Update With Config",
        contact_email: "upd.config@prova.com",
        title: "Update con config",
        start_time: start,
      }),
    });
    const rB = await resB.json();
    assert.equal(resB.status, 201);
    const bookingId = rB.booking.id;

    // Forza google_event_id via UPDATE diretto SQL
    await query(
      "UPDATE booking_appointments SET google_event_id = $1 WHERE id = $2",
      ["fake-google-event-id-upd-config", bookingId]
    );

    // PUT booking: cambia title — tryUpdateEvent tenterà ma Google rifiuterà
    // (token finto). Il booking NON deve tornare errore 500: graceful skip
    const res2 = await fetch(`${baseUrl}/v1/bookings/${bookingId}`, {
      method: "PUT",
      headers: headers(apiKeyA),
      body: JSON.stringify({ title: "Update con config — aggiornato" }),
    });
    assert.equal(res2.status, 200, `PUT dopo google_event_id con config: ${res2.status}`);
    const r2 = await res2.json();
    assert.equal(r2.booking.title, "Update con config — aggiornato");

    // Pulisci
    await query("DELETE FROM booking_appointments WHERE id = $1", [bookingId]);
    await query("DELETE FROM booking_calendar_config WHERE site_id = $1", [siteA.id]);
    await query("DELETE FROM oauth_connections WHERE id = $1", [fakeConnId]);
    await query("DELETE FROM oauth_apps WHERE id = $1", [fakeAppId]);
  });
});