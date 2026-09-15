import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 2 — End-to-end: creazione booking via POST /v1/bookings deve accodare
// delivery webhook out per gli eventi 'booking_created' e 'booking_cancelled'.
// Il flusso: POST /v1/bookings → services/booking.js → createBooking →
// emitContactEvent(siteId, email, "booking_created", { ... }) →
// events.js → enqueueForEvent → webhook_deliveries.
describe("ONDA 2 — booking → webhook OUT e2e", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;

  before(async () => {
    siteA = await createTestSite("O2 WH Tenant A");
    siteB = await createTestSite("O2 WH Tenant B");

    // API key per tenant A
    const rawA = "whkey_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "booking key", crypto.createHash("sha256").update(rawA).digest("hex"), rawA.slice(0, 12)]
    );
    apiKeyA = { raw: rawA };

    // API key per tenant B
    const rawB = "whkey_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteB.id, "booking key B", crypto.createHash("sha256").update(rawB).digest("hex"), rawB.slice(0, 12)]
    );
    apiKeyB = { raw: rawB };

    // Webhook OUT attivo su A che inoltra booking_created
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'booking-out', 'out', 'https://n8n.example.test/booking', 'hooksecret', '["booking_created","booking_cancelled"]', true)`,
      [siteA.id]
    );

    // Webhook OUT attivo su B (deve rimanere isolato)
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'booking-out-b', 'out', 'https://n8n.example.test/booking-b', 's', '["booking_created"]', true)`,
      [siteB.id]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = (tenant, key) => ({
    "Location-Id": String(tenant),
    Authorization: `Bearer ${key}`,
    Version: "2017-04-19",
    "Content-Type": "application/json",
  });

  test("creazione booking genera delivery webhook out per booking_created", async () => {
    const res = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: auth(siteA.id, apiKeyA.raw),
      body: JSON.stringify({
        contact_name: "E2E Webbook",
        contact_email: "e2e-booking@example.test",
        title: "Test e2e booking webhook",
        start_time: new Date(Date.now() + 86400000).toISOString(),
      }),
    });
    assert.equal(res.status, 201, "booking creato con successo");
    const body = await res.json();
    assert.ok(body.booking?.id > 0, "booking.id positivo");

    // Polling: attendi che la delivery webhook appaia
    let deliveries = [];
    for (let i = 0; i < 20; i++) {
      deliveries = (await query(
        `SELECT d.* FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.site_id = $1 AND d.event_type = 'booking_created'`,
        [siteA.id]
      )).rows;
      if (deliveries.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(deliveries.length > 0, "devono esserci delivery per booking_created");
    assert.equal(deliveries[0].event_type, "booking_created");

    // Verifica che il payload contenga i dati del booking
    const payload = typeof deliveries[0].payload === "string"
      ? JSON.parse(deliveries[0].payload)
      : deliveries[0].payload;
    assert.equal(payload.booking_id, body.booking.id, "booking_id nel payload corrisponde");
    assert.match(payload.title || "", /Test e2e booking/);
    assert.ok(payload.start_time, "start_time presente nel payload");
  });

  test("webhook delivery isolata per tenant: tenant B non riceve eventi booking di A", async () => {
    const bDeliveries = (await query(
      `SELECT d.* FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.site_id = $1 AND d.event_type = 'booking_created'`,
      [siteB.id]
    )).rows;
    // B ha webhook per booking_created, ma non ha creato booking,
    // quindi non dovrebbe avere delivery
    assert.equal(bDeliveries.length, 0, "tenant B non ha delivery di A");
  });

  test("cancellazione booking genera delivery webhook out per booking_cancelled", async () => {
    // Crea un secondo booking su A
    const createRes = await fetch(`${baseUrl}/v1/bookings`, {
      method: "POST",
      headers: auth(siteA.id, apiKeyA.raw),
      body: JSON.stringify({
        contact_name: "Cancel Test",
        contact_email: "cancel-test@example.test",
        title: "Test cancellazione webhook",
        start_time: new Date(Date.now() + 172800000).toISOString(),
      }),
    });
    assert.equal(createRes.status, 201);
    const { booking } = await createRes.json();

    // Cancella (DELETE /v1/bookings/:id → soft-delete con status=cancelled)
    const delRes = await fetch(`${baseUrl}/v1/bookings/${booking.id}`, {
      method: "DELETE",
      headers: auth(siteA.id, apiKeyA.raw),
    });
    assert.equal(delRes.status, 200);

    // Polling per booking_cancelled delivery
    let deliveries = [];
    for (let i = 0; i < 20; i++) {
      deliveries = (await query(
        `SELECT d.* FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.site_id = $1 AND d.event_type = 'booking_cancelled'`,
        [siteA.id]
      )).rows;
      if (deliveries.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(deliveries.length > 0, "devono esserci delivery per booking_cancelled");
    assert.equal(deliveries[0].event_type, "booking_cancelled");
  });
});