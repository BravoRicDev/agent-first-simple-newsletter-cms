import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import v1Routes from "../src/routes/v1.js";
import { query } from "../src/db.js";
import { closeDb, createTestSite } from "./helpers.js";
import crypto from "crypto";

// ONDA 2 — booking system: CRUD appuntamenti prenotati via surface /v1.
// Pattern identico a f0-foundations.test.js: app Express di test + v1Routes
// su /v1, due tenant per isolamento, API key dirette su site_api_keys.
describe("ONDA 2 — booking API /v1", () => {
  let server, baseUrl;
  let siteA, siteB, apiKeyA, apiKeyB;

  before(async () => {
    // Pulisci booking del tenant
    await query("DELETE FROM booking_appointments WHERE site_id IN (SELECT id FROM sites ORDER BY id DESC LIMIT 5)");

    // Crea due siti di test
    siteA = await createTestSite();
    siteB = await createTestSite();

    // API key per-tenant (inserimento diretto, come f0-foundations)
    const tokenA = crypto.randomBytes(32).toString("hex");
    const tokenB = crypto.randomBytes(32).toString("hex");
    const hashA = crypto.createHash("sha256").update(tokenA).digest("hex");
    const hashB = crypto.createHash("sha256").update(tokenB).digest("hex");

    await query(
      `INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active)
       VALUES ($1, $2, $3, $4, true)`,
      [siteA.id, "test-key-A", hashA, tokenA.slice(0, 8)]
    );
    await query(
      `INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active)
       VALUES ($1, $2, $3, $4, true)`,
      [siteB.id, "test-key-B", hashB, tokenB.slice(0, 8)]
    );
    apiKeyA = tokenA;
    apiKeyB = tokenB;

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
    await query("DELETE FROM booking_appointments WHERE site_id = $1", [siteA.id]);
    await query("DELETE FROM booking_appointments WHERE site_id = $1", [siteB.id]);
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

  test("401 senza credenziali", async () => {
    const res = await fetch(`${baseUrl}/v1/bookings`, { headers: { accept: "application/json" } });
    assert.equal(res.status, 401);
  });

  test("CRUD booking + isolamento tenant", async () => {
    // Crea booking
    const startA = new Date(Date.now() + 86400000).toISOString(); // domani
    const res1 = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({
        contact_name: "Mario Rossi",
        contact_email: "mario@esempio.com",
        contact_phone: "+391234567890",
        title: "Consulenza iniziale",
        description: "Primo incontro di consulenza strategica",
        start_time: startA,
        timezone: "Europe/Rome",
      }),
    });
    const r1 = await res1.json();
    assert.equal(res1.status, 201, `POST bookings: ${JSON.stringify(r1)}`);
    assert.ok(r1.booking?.id > 0);
    assert.equal(r1.booking.contact_email, "mario@esempio.com");
    assert.equal(r1.booking.status, "confirmed");
    assert.equal(r1.booking.title, "Consulenza iniziale");
    const bookingId = r1.booking.id;

    // GET /bookings/:id
    const res2 = await fetch(`${baseUrl}/v1/bookings/${bookingId}`, { headers: headers(apiKeyA) });
    assert.equal(res2.status, 200);
    const r2 = await res2.json();
    assert.equal(r2.booking.id, bookingId);
    assert.equal(r2.booking.title, "Consulenza iniziale");

    // LIST bookings
    const res3 = await fetch(`${baseUrl}/v1/bookings`, { headers: headers(apiKeyA) });
    assert.equal(res3.status, 200);
    const r3 = await res3.json();
    assert.ok(r3.bookings.length >= 1);

    // Isolamento tenant B non vede booking di A
    const res4 = await fetch(`${baseUrl}/v1/bookings/${bookingId}`, { headers: headers(apiKeyB, siteB.id) });
    assert.equal(res4.status, 404);

    // UPDATE booking
    const res5 = await fetch(`${baseUrl}/v1/bookings/${bookingId}`, {
      method: "PUT",
      headers: headers(apiKeyA),
      body: JSON.stringify({ title: "Consulenza avanzata", contact_email: "mario.aggiornato@esempio.com" }),
    });
    assert.equal(res5.status, 200);
    const r5 = await res5.json();
    assert.equal(r5.booking.title, "Consulenza avanzata");
    assert.equal(r5.booking.contact_email, "mario.aggiornato@esempio.com");

    // CANCEL booking (DELETE)
    const res6 = await fetch(`${baseUrl}/v1/bookings/${bookingId}`, {
      method: "DELETE",
      headers: headers(apiKeyA),
    });
    assert.equal(res6.status, 200);
    const r6 = await res6.json();
    assert.equal(r6.booking.status, "cancelled");
    assert.ok(r6.booking.cancelled_at);

    // 404 per booking cancellato (esiste ancora ma non è errore per il test)
    const res7 = await fetch(`${baseUrl}/v1/bookings/${bookingId}`, { headers: headers(apiKeyA) });
    assert.equal(res7.status, 200); // esiste ancora
    const r7 = await res7.json();
    assert.equal(r7.booking.status, "cancelled");
  });

  test("validazione: contact_email obbligatorio", async () => {
    const start = new Date(Date.now() + 86400000).toISOString();
    const res = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({ start_time: start, title: "Test" }),
      // senza contact_email
    });
    assert.equal(res.status, 400);
  });

  test("validazione: title obbligatorio", async () => {
    const start = new Date(Date.now() + 86400000).toISOString();
    const res = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({ start_time: start, contact_email: "test@prova.com" }),
      // senza title
    });
    assert.equal(res.status, 400);
  });

  test("filtri: list per status e contactEmail", async () => {
    // Crea un booking cancellato
    const start = new Date(Date.now() + 172800000).toISOString(); // dopodomani
    const res1 = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: headers(apiKeyA),
      body: JSON.stringify({
        contact_name: "Laura Bianchi",
        contact_email: "laura@prova.com",
        title: "Colloquio",
        start_time: start,
      }),
    });
    const r1 = await res1.json();
    assert.equal(res1.status, 201);
    const id2 = r1.booking.id;

    // Cancella
    await fetch(`${baseUrl}/v1/bookings/${id2}`, { method: "DELETE", headers: headers(apiKeyA) });

    // Filtro per status: confirmed
    const res2 = await fetch(`${baseUrl}/v1/bookings?q[status]=confirmed`, { headers: headers(apiKeyA) });
    const r2 = await res2.json();
    assert.equal(res2.status, 200);
    r2.bookings.forEach((b) => assert.equal(b.status, "confirmed"));

    // Filtro per contactEmail
    const res3 = await fetch(`${baseUrl}/v1/bookings?q[contactEmail]=laura@prova.com`, { headers: headers(apiKeyA) });
    const r3 = await res3.json();
    assert.equal(res3.status, 200);
    assert.ok(r3.bookings.length >= 1);
    r3.bookings.forEach((b) => assert.equal(b.contact_email, "laura@prova.com"));
  });

  test("config per-tenant: durata/timezone/lead-time/window", async () => {
    const keys = ["booking_duration_minutes", "booking_timezone", "booking_lead_time_hours", "booking_window_days"];

    // Configura i default per-tenant su siteA (valori scalari in JSONB).
    const cfg = {
      booking_duration_minutes: 45,
      booking_timezone: "Europe/Rome",
      booking_lead_time_hours: 24,
      booking_window_days: 10,
    };
    for (const [k, v] of Object.entries(cfg)) {
      await query(
        `INSERT INTO tenant_config (site_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [siteA.id, k, JSON.stringify(v)]
      );
    }

    try {
      // Durata default 45min + timezone default Europe/Rome quand NON passati.
      const start = new Date(Date.now() + 2 * 86400000).toISOString(); // tra 2 giorni
      const res1 = await fetch(`${baseUrl}/v1/bookings`, {
        method: "POST",
        headers: headers(apiKeyA),
        body: JSON.stringify({ contact_name: "Cfg Test", contact_email: "cfg@prova.com", title: "Con config", start_time: start }),
      });
      const r1 = await res1.json();
      assert.equal(res1.status, 201, `POST con config: ${JSON.stringify(r1)}`);
      const s = new Date(r1.booking.start_time).getTime();
      const e = new Date(r1.booking.end_time).getTime();
      assert.equal((e - s) / 60000, 45, "durata default da config (45 min)");
      assert.equal(r1.booking.timezone, "Europe/Rome", "timezone default da config");
      await query("DELETE FROM booking_appointments WHERE id = $1", [r1.booking.id]);

      // Lead time: start dentro 24h → 400.
      const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // tra 2 ore
      const res2 = await fetch(`${baseUrl}/v1/bookings`, {
        method: "POST",
        headers: headers(apiKeyA),
        body: JSON.stringify({ contact_email: "lead@prova.com", title: "Troppo presto", start_time: soon }),
      });
      assert.equal(res2.status, 400, `lead time: atteso 400, got ${res2.status}`);

      // Lead time: start nel passato → 400.
      const past = new Date(Date.now() - 3600 * 1000).toISOString();
      const resPast = await fetch(`${baseUrl}/v1/bookings`, {
        method: "POST",
        headers: headers(apiKeyA),
        body: JSON.stringify({ contact_email: "past@prova.com", title: "Passato", start_time: past }),
      });
      assert.equal(resPast.status, 400, `passato: atteso 400, got ${resPast.status}`);

      // Window: start oltre 10 giorni → 400.
      const far = new Date(Date.now() + 11 * 86400000).toISOString();
      const res3 = await fetch(`${baseUrl}/v1/bookings`, {
        method: "POST",
        headers: headers(apiKeyA),
        body: JSON.stringify({ contact_email: "far@prova.com", title: "Troppo lontano", start_time: far }),
      });
      assert.equal(res3.status, 400, `window: atteso 400, got ${res3.status}`);

      // Dentro finestra e oltre lead → 201.
      const ok = new Date(Date.now() + 2 * 86400000).toISOString();
      const res4 = await fetch(`${baseUrl}/v1/bookings`, {
        method: "POST",
        headers: headers(apiKeyA),
        body: JSON.stringify({ contact_email: "ok@prova.com", title: "OK", start_time: ok }),
      });
      assert.equal(res4.status, 201, `dentro finestra: ${res4.status}`);
      const r4 = await res4.json();
      await query("DELETE FROM booking_appointments WHERE id = $1", [r4.booking.id]);
    } finally {
      // Pulisci la config per non lasciare stati sporchi tra i run.
      await query("DELETE FROM tenant_config WHERE site_id = $1 AND key = ANY($2::text[])", [siteA.id, keys]);
    }
  });
});