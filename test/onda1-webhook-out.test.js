import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 1 — Webhook OUT: la creazione di un contatto via POST /v1/contacts
// deve accodare una delivery per ogni webhook out attivo che inoltra
// 'contact_created' (feature 35 → events.js → webhooks.js → n8n).
describe("ONDA 1 — webhook OUT su contact_created", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA;

  before(async () => {
    siteA = await createTestSite("O1 WH Tenant A");
    siteB = await createTestSite("O1 WH Tenant B");

    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key A", hash, raw.slice(0, 12)]
    );
    apiKeyA = { raw };

    // Webhook OUT attivo su A che inoltra contact_created.
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'out1', 'out', 'https://n8n.example.test/hook/1', 'secret', '["contact_created"]', true)`,
      [siteA.id]
    );
    // Webhook OUT su B (diverso tenant, non deve ricevere eventi di A).
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'outB', 'out', 'https://n8n.example.test/hook/2', 's', '["contact_created"]', true)`,
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
  });

  test("creazione contatto genera delivery webhook out per il tenant (contact_created)", async () => {
    const res = await fetch(`${baseUrl}/v1/contacts`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wh@example.test", name: "Whitest" }),
    });
    assert.equal(res.status, 201);

    // Il flusso eventi è fire-and-forget: attendi brevemente l'enqueue.
    let deliveries = [];
    for (let i = 0; i < 20; i++) {
      deliveries = (await query(
        `SELECT d.* FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.site_id = $1 AND d.event_type = 'contact_created'`,
        [siteA.id]
      )).rows;
      if (deliveries.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(deliveries.length > 0, "devono esserci delivery per contact_created");
    assert.equal(deliveries[0].event_type, "contact_created");
    assert.match(JSON.stringify(deliveries[0].payload), /wh@example\.test/);

    // Isolamento: tenant B non deve avere delivery per l'evento di A.
    const bDeliveries = (await query(
      `SELECT d.* FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.site_id = $1 AND d.event_type = 'contact_created'`,
      [siteB.id]
    )).rows;
    assert.equal(bDeliveries.length, 0);
  });
});
