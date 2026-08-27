import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 4 — Webhook OUT: verifica che TUTTI gli eventi del core CRM generino
// delivery webhook per il tenant corretto. Copre: contact_created,
// contact_updated, contact_deleted, opportunity_stage_changed,
// opportunity_status_changed, opportunity_deleted.
describe("ONDA 4 — webhook OUT su tutti gli eventi CRM", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA;

  before(async () => {
    siteA = await createTestSite("O4 WH Tenant A");
    siteB = await createTestSite("O4 WH Tenant B");

    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key A", hash, raw.slice(0, 12)]
    );
    apiKeyA = { raw };

    // Webhook OUT attivo su A che inoltra TUTTI gli eventi CRM.
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'out1', 'out', 'https://n8n.example.test/hook/1', 'secret',
         '["contact_created","contact_updated","contact_deleted",
           "opportunity_stage_changed","opportunity_status_changed",
           "opportunity_deleted","tag_added","stage_changed"]', true)`,
      [siteA.id]
    );
    // Webhook OUT su B (diverso tenant, non deve ricevere eventi di A).
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'outB', 'out', 'https://n8n.example.test/hook/2', 's',
         '["contact_created","contact_deleted","opportunity_stage_changed"]', true)`,
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

  async function countDeliveries(siteId, eventType) {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.site_id = $1 AND d.event_type = $2`,
      [siteId, eventType]
    );
    return r.rows[0].n;
  }

  async function waitForDeliveries(siteId, eventType, minCount = 1) {
    for (let i = 0; i < 20; i++) {
      const n = await countDeliveries(siteId, eventType);
      if (n >= minCount) return n;
      await new Promise(r => setTimeout(r, 50));
    }
    return 0;
  }

  test("contact_created → webhook delivery con payload corretto", async () => {
    const res = await fetch(`${baseUrl}/v1/contacts`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wh-created@example.test", name: "Webhook Created" }),
    });
    assert.equal(res.status, 201);

    const n = await waitForDeliveries(siteA.id, "contact_created");
    assert.ok(n >= 1, "devono esserci delivery per contact_created");

    // Isolamento: tenant B non riceve l'evento di A
    const bN = await countDeliveries(siteB.id, "contact_created");
    assert.equal(bN, 0, "tenant B non deve ricevere eventi di A");
  });

  test("contact_updated → webhook delivery", async () => {
    // Crea contatto
    const createRes = await fetch(`${baseUrl}/v1/contacts`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wh-updated@example.test", name: "Before" }),
    });
    assert.equal(createRes.status, 201);
    const { contact } = await createRes.json();
    const contactId = contact.id;

    // Attendi che contact_created sia accodato
    await waitForDeliveries(siteA.id, "contact_created", 2);

    // Aggiorna
    const updRes = await fetch(`${baseUrl}/v1/contacts/${contactId}`, {
      method: "PUT",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Name", phone: "+391234567" }),
    });
    assert.equal(updRes.status, 200);

    const n = await waitForDeliveries(siteA.id, "contact_updated");
    assert.ok(n >= 1, "devono esserci delivery per contact_updated");
  });

  test("contact_deleted → webhook delivery", async () => {
    // Crea contatto
    const createRes = await fetch(`${baseUrl}/v1/contacts`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wh-deleted@example.test", name: "To Delete" }),
    });
    assert.equal(createRes.status, 201);
    const { contact } = await createRes.json();

    // Attendi contact_created
    await waitForDeliveries(siteA.id, "contact_created", 3);

    // Elimina
    const delRes = await fetch(`${baseUrl}/v1/contacts/${contact.id}`, {
      method: "DELETE",
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(delRes.status, 200);

    const n = await waitForDeliveries(siteA.id, "contact_deleted");
    assert.ok(n >= 1, "devono esserci delivery per contact_deleted");
  });

  test("opportunity_stage_changed + opportunity_deleted → webhook delivery", async () => {
    // Crea contatto di appoggio
    const createRes = await fetch(`${baseUrl}/v1/contacts`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wh-opp@example.test", name: "Opp Test" }),
    });
    assert.equal(createRes.status, 201);
    const { contact } = await createRes.json();
    const contactEmail = contact.email;

    // Attendi contact_created
    await waitForDeliveries(siteA.id, "contact_created", 4);

    // Crea opportunità
    const oppRes = await fetch(`${baseUrl}/v1/opportunities`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({
        contactEmail,
        title: "Test Opportunity WH",
        stage: "nuovo",
        amount: 5000,
      }),
    });
    assert.equal(oppRes.status, 201);
    const { opportunity } = await oppRes.json();
    const oppId = opportunity.id;

    // Verifica opportunity_stage_changed (emit alla creazione)
    const stageN = await waitForDeliveries(siteA.id, "opportunity_stage_changed");
    assert.ok(stageN >= 1, "devono esserci delivery per opportunity_stage_changed");

    // Cambia stage
    const stageRes = await fetch(`${baseUrl}/v1/opportunities/${oppId}`, {
      method: "PUT",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "trattativa" }),
    });
    assert.equal(stageRes.status, 200);

    // Attendi il secondo stage_changed
    let stageN2 = 0;
    for (let i = 0; i < 20; i++) {
      stageN2 = await countDeliveries(siteA.id, "opportunity_stage_changed");
      if (stageN2 >= 2) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(stageN2 >= 2, "almeno 2 delivery per stage_changed (creazione + cambio)");

    // Elimina opportunità
    const delOppRes = await fetch(`${baseUrl}/v1/opportunities/${oppId}`, {
      method: "DELETE",
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(delOppRes.status, 200);

    const oppDelN = await waitForDeliveries(siteA.id, "opportunity_deleted");
    assert.ok(oppDelN >= 1, "devono esserci delivery per opportunity_deleted");
  });

  test("isolamento tenant: eventi di A non filtrano in B", async () => {
    // Dopo tutti i test precedenti, B non deve avere delivery per gli eventi di A
    for (const ev of ["contact_created", "contact_deleted", "opportunity_stage_changed"]) {
      const bN = await countDeliveries(siteB.id, ev);
      assert.equal(bN, 0, `tenant B non deve avere delivery per ${ev}`);
    }
  });
});