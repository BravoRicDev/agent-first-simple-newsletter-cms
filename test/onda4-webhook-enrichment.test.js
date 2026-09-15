import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 4 — Webhook OUT event enrichment: verifica che il payload inviato
// via webhook contenga i dati completi del contatto/opportunità e i custom
// field, e non solo il payload minimo dell'evento.
describe("ONDA 4 — webhook OUT event enrichment", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA;
  let receivedBodies = [];
  let webhookServer;

  before(async () => {
    siteA = await createTestSite("O4 ENR Tenant A");
    siteB = await createTestSite("O4 ENR Tenant B");

    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key A", hash, raw.slice(0, 12)]
    );
    apiKeyA = { raw };

    // Server HTTP locale per catturare i webhook inviati
    const whApp = express();
    whApp.use(express.json());
    whApp.post("/hook", (req, res) => {
      receivedBodies.push(req.body);
      res.status(200).json({ ok: true });
    });
    await new Promise(resolve => {
      webhookServer = whApp.listen(0, () => resolve());
    });
    const whPort = webhookServer.address().port;

    // Webhook OUT attivo su A che inoltra TUTTI gli eventi CRM
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'out-enrich', 'out', $2, 'secret',
         '[\"contact_created\",\"contact_updated\",\"contact_deleted\",
           \"opportunity_stage_changed\",\"opportunity_status_changed\",
           \"opportunity_deleted\",\"tag_added\",\"stage_changed\"]', true)`,
      [siteA.id, `http://localhost:${whPort}/hook`]
    );

    // Webhook OUT su B (diverso tenant, non deve ricevere eventi di A)
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'outB', 'out', $2, 's',
         '[\"contact_created\",\"contact_deleted\",\"opportunity_stage_changed\"]', true)`,
      [siteB.id, `http://localhost:${whPort}/hook`]
    );

    // Crea custom field per tenant A (contact + opportunity)
    await query(
      `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, active)
       VALUES ($1, 'contact', 'cf_testo', 'Testo Custom', 'text', true)`,
      [siteA.id]
    );
    await query(
      `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, active)
       VALUES ($1, 'contact', 'cf_numero', 'Numero Custom', 'number', true)`,
      [siteA.id]
    );
    await query(
      `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, active)
       VALUES ($1, 'opportunity', 'cf_opp_testo', 'Opp Testo', 'text', true)`,
      [siteA.id]
    );

    // App v1 per creare contatti/opportunità
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
    server?.closeAllConnections?.();
    server?.close();
    webhookServer?.closeAllConnections?.();
    webhookServer?.close();
    await closeDb();
  });

  const auth = (tenant, key) => ({
    "Location-Id": String(tenant),
    Authorization: `Bearer ${key}`,
    Version: "2017-04-19",
  });

  async function waitForDeliveries(siteId, eventType, minCount = 1) {
    for (let i = 0; i < 30; i++) {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.site_id = $1 AND d.event_type = $2`,
        [siteId, eventType]
      );
      if (r.rows[0].n >= minCount) return r.rows[0].n;
      await new Promise(r => setTimeout(r, 100));
    }
    return 0;
  }

  async function drainDeliveries(siteId) {
    const mod = await import("../src/services/webhooks.js");
    const result = await mod.deliverPending(200, { siteId, allowPrivate: true });
    return result;
  }

  async function countDeliveries(siteId, eventType) {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.site_id = $1 AND d.event_type = $2`,
      [siteId, eventType]
    );
    return r.rows[0].n;
  }

  test("contact_created → payload arricchito con dati completi contatto + custom fields", async () => {
    receivedBodies = [];

    // Crea contatto con custom fields
    const res = await fetch(`${baseUrl}/v1/contacts`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "enrich-contact@example.test",
        name: "Mario Rossi",
        phone: "+391****6789",
        companyName: "ACME SpA",
        website: "https://acme.test",
        tags: ["lead", "web"],
        customFields: { cf_testo: "valore custom", cf_numero: 42 },
      }),
    });
    assert.equal(res.status, 201);
    const { contact } = await res.json();
    assert.ok(contact.id);

    const n = await waitForDeliveries(siteA.id, "contact_created");
    assert.ok(n >= 1, "deve esserci delivery per contact_created");

    const drainResult = await drainDeliveries(siteA.id);
    assert.ok(drainResult.delivered >= 1, "almeno 1 delivery deve essere consegnata");

    const body = receivedBodies.find(b => b.event_type === "contact_created");
    assert.ok(body, "deve aver ricevuto il body contact_created");

    const payload = body.payload;
    assert.ok(payload.contact, "payload deve avere contact arricchito");
    assert.equal(payload.contact.email, "enrich-contact@example.test");
    assert.equal(payload.contact.name, "Mario Rossi");
    assert.equal(payload.contact.firstName, "Mario");
    assert.equal(payload.contact.lastName, "Rossi");
    assert.equal(payload.contact.phone, "+391****6789");
    assert.equal(payload.contact.companyName, "ACME SpA");
    assert.equal(payload.contact.website, "https://acme.test");
    assert.deepEqual(payload.contact.tags, ["lead", "web"]);

    assert.ok(payload.contact.customFields, "deve avere customFields");
    assert.equal(payload.contact.customFields.cf_testo, "valore custom");
    assert.equal(payload.contact.customFields.cf_numero, 42);

    assert.equal(payload.contact.id, contact.id);
    assert.ok(payload.contact.createdAt);
    assert.ok(payload.contact.updatedAt);
  });

  test("contact_updated → payload arricchito con dati aggiornati", async () => {
    receivedBodies = [];

    const listRes = await fetch(`${baseUrl}/v1/contacts?query=enrich-contact@example.test`, {
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    const { contacts } = await listRes.json();
    const c = contacts.find(ct => ct.email === "enrich-contact@example.test");
    assert.ok(c, "contatto deve esistere");
    const contactId = c.id;

    const updRes = await fetch(`${baseUrl}/v1/contacts/${contactId}`, {
      method: "PUT",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mario Rossi Jr",
        phone: "+399****4321",
        customFields: { cf_testo: "valore aggiornato" },
      }),
    });
    assert.equal(updRes.status, 200);

    const n = await waitForDeliveries(siteA.id, "contact_updated");
    assert.ok(n >= 1, "deve esserci delivery per contact_updated");

    await drainDeliveries(siteA.id);

    const body = receivedBodies.find(b => b.event_type === "contact_updated");
    assert.ok(body, "deve aver ricevuto il body contact_updated");

    const payload = body.payload;
    assert.ok(payload.contact, "payload deve avere contact arricchito");
    assert.equal(payload.contact.name, "Mario Rossi Jr");
    assert.equal(payload.contact.phone, "+399****4321");
    assert.equal(payload.contact.customFields.cf_testo, "valore aggiornato");
    assert.equal(payload.contact.customFields.cf_numero, 42, "cf_numero deve persistere dal merge");
  });

  test("opportunity_stage_changed → payload arricchito con opportunità + custom fields + contatto", async () => {
    receivedBodies = [];

    const oppRes = await fetch(`${baseUrl}/v1/opportunities`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({
        contactEmail: "enrich-contact@example.test",
        title: "Enrich Deal",
        stage: "nuovo",
        amount: 15000,
        probability: 30,
        customFields: { cf_opp_testo: "opportunità custom" },
      }),
    });
    assert.equal(oppRes.status, 201);
    const { opportunity } = await oppRes.json();
    assert.ok(opportunity.id);
    const oppId = opportunity.id;

    const n = await waitForDeliveries(siteA.id, "opportunity_stage_changed");
    assert.ok(n >= 1, "deve esserci delivery per opportunity_stage_changed");

    await drainDeliveries(siteA.id);

    const body = receivedBodies.find(b => b.event_type === "opportunity_stage_changed");
    assert.ok(body, "deve aver ricevuto il body opportunity_stage_changed");

    const payload = body.payload;
    assert.ok(payload.opportunity, "payload deve avere opportunity arricchita");
    assert.equal(payload.opportunity.id, oppId);
    assert.equal(payload.opportunity.title, "Enrich Deal");
    assert.equal(payload.opportunity.stage, "nuovo");
    assert.equal(payload.opportunity.amount, 15000);
    assert.equal(payload.opportunity.contactEmail, "enrich-contact@example.test");

    assert.ok(payload.opportunity.customFields, "deve avere customFields");
    assert.equal(payload.opportunity.customFields.cf_opp_testo, "opportunità custom");

    assert.ok(payload.contact, "payload deve avere anche contact arricchito (da contactEmail)");
    assert.equal(payload.contact.email, "enrich-contact@example.test");

    // Cambia stage
    receivedBodies = [];
    const stageRes = await fetch(`${baseUrl}/v1/opportunities/${oppId}`, {
      method: "PUT",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "trattativa" }),
    });
    assert.equal(stageRes.status, 200);

    const n2 = await waitForDeliveries(siteA.id, "opportunity_stage_changed", 2);
    assert.ok(n2 >= 2, "almeno 2 delivery per stage_changed");

    await drainDeliveries(siteA.id);

    const body2 = receivedBodies.filter(b => b.event_type === "opportunity_stage_changed").pop();
    if (body2) {
      const p2 = body2.payload;
      assert.ok(p2.opportunity, "deve avere opportunity arricchita");
      assert.equal(p2.opportunity.stage, "trattativa");
      assert.ok(p2.contact, "deve avere contact arricchito");
    }
  });

  test("opportunity_deleted → payload arricchito (best-effort)", async () => {
    receivedBodies = [];

    const listRes = await fetch(`${baseUrl}/v1/opportunities`, {
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    const { opportunities } = await listRes.json();
    const opp = opportunities.find(o => o.title === "Enrich Deal");
    assert.ok(opp, "opportunità deve esistere");
    const oppId = opp.id;

    const delRes = await fetch(`${baseUrl}/v1/opportunities/${oppId}`, {
      method: "DELETE",
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(delRes.status, 200);

    const n = await waitForDeliveries(siteA.id, "opportunity_deleted");
    assert.ok(n >= 1, "deve esserci delivery per opportunity_deleted");

    await drainDeliveries(siteA.id);

    const body = receivedBodies.find(b => b.event_type === "opportunity_deleted");
    assert.ok(body, "deve aver ricevuto il body opportunity_deleted");
    const payload = body.payload;
    assert.equal(payload.opportunity_id, oppId);
    if (payload.opportunity) {
      assert.equal(payload.opportunity.title, "Enrich Deal");
    }
  });

  test("isolamento tenant: eventi di A non filtrano in B", async () => {
    for (const ev of ["contact_created", "contact_deleted", "opportunity_stage_changed"]) {
      const bN = await countDeliveries(siteB.id, ev);
      assert.equal(bN, 0, `tenant B non deve avere delivery per ${ev}`);
    }
  });

  test("enrichPayload esportata e funziona standalone", async () => {
    const { enrichPayload } = await import("../src/services/webhooks.js");
    assert.ok(typeof enrichPayload === "function", "enrichPayload deve essere una funzione");

    const delivery = {
      id: -1,
      site_id: siteA.id,
      event_type: "contact_created",
      payload: { contact_id: -999, email: "fake@example.test" },
    };
    await enrichPayload(delivery);
    assert.equal(delivery.payload.contact, undefined,
      "contatto inesistente non deve essere aggiunto al payload");
  });
});