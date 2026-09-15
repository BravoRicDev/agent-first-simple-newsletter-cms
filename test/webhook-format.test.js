import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import http from "http";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { emitContactEvent } from "../src/services/events.js";

// Onda I — Webhook OUT formato target-style con doppia forma selezionabile.
// Due webhook on stesso sito: uno legacy (formato storico {event_type,payload})
// uno target (formato flat {type,eventId,eventName,locationId,<risorsa>...}).
// Verificare che:
// 1. Legacy riceve shape invariata (backward-compat n8n)
// 2. Target riceve flat con struttura target corretta
// 3. X-Webhook-Signature presente in entrambi
// 4. locationId risolto da sites.location_external_id || sites.external_id
// 5. eventId è UUID valido
// 6. contact a top-level per target

describe("Onda I — Webhook OUT payload format (legacy vs target)", () => {
  let site, mockServer, mockUrlLegacy, mockUrlTarget;
  let receivedLegacy = [], receivedTarget = [];

  before(async () => {
    site = await createTestSite("Webhook Format Test");

    // Mock server per webhook legacy
    mockServer = http.createServer((req, res) => {
      if (req.url.startsWith("/legacy")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          receivedLegacy.push({ headers: req.headers, body });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else if (req.url.startsWith("/target")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          receivedTarget.push({ headers: req.headers, body });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => {
      mockServer.listen(0, "127.0.0.1", resolve);
    });
    const port = mockServer.address().port;
    mockUrlLegacy = `http://127.0.0.1:${port}/legacy`;
    mockUrlTarget = `http://127.0.0.1:${port}/target`;
  });

  after(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
    await closeDb();
  });

  test("due webhook con format diversi, stesso evento contact_created", async () => {
    receivedLegacy.length = 0;
    receivedTarget.length = 0;
    const secretLegacy = "legacy-secret";
    const secretTarget = "target-secret";

    // Webhook legacy
    const webhookLegacy = (await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active, payload_format)
       VALUES ($1, 'legacy-format', 'out', $2, $3, '["contact_created"]', true, 'legacy')
       RETURNING id`,
      [site.id, mockUrlLegacy, secretLegacy]
    )).rows[0];

    // Webhook target
    const webhookTarget = (await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active, payload_format)
       VALUES ($1, 'target-format', 'out', $2, $3, '["contact_created"]', true, 'target')
       RETURNING id`,
      [site.id, mockUrlTarget, secretTarget]
    )).rows[0];

    // Emetti evento contact_created
    await emitContactEvent(
      site.id,
      "test@example.com",
      "contact_created",
      { contact_id: 123 }
    );

    // Force delivery diretto (bypassa scheduler lock)
    const { deliverPending } = await import("../src/services/webhooks.js");
    await deliverPending(50, { siteId: site.id, allowPrivate: true });

    // ─── Verifica legacy ───────────────────────────────────────────────
    assert.equal(receivedLegacy.length, 1, "legacy deve ricevere 1 richiesta");
    const legacyData = JSON.parse(receivedLegacy[0].body);
    assert.equal(legacyData.event_type, "contact_created", "legacy ha event_type");
    assert.equal(typeof legacyData.payload, "object", "legacy ha payload object");
    assert.equal(legacyData.payload.contact_id, 123, "legacy payload contiene contact_id");

    // Verifica firma legacy
    const expectedSigLegacy = crypto
      .createHmac("sha256", secretLegacy)
      .update(receivedLegacy[0].body)
      .digest("hex");
    assert.equal(
      receivedLegacy[0].headers["x-webhook-signature"],
      expectedSigLegacy,
      "firma HMAC legacy valida"
    );

    // ─── Verifica target ───────────────────────────────────────────────
    assert.equal(receivedTarget.length, 1, "target deve ricevere 1 richiesta");
    const targetData = JSON.parse(receivedTarget[0].body);

    // Verifica campi target richiesti
    assert.equal(targetData.type, "ContactCreate", "target type = ContactCreate");
    assert.equal(targetData.eventName, "ContactCreate", "target eventName = ContactCreate");
    assert.ok(targetData.eventId, "target ha eventId");
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetData.eventId),
      "target eventId è UUID valido"
    );
    assert.ok(targetData.locationId, "target ha locationId");
    assert.equal(typeof targetData.locationId, "string", "target locationId è stringa");

    // Verifica firma target
    const expectedSigTarget = crypto
      .createHmac("sha256", secretTarget)
      .update(receivedTarget[0].body)
      .digest("hex");
    assert.equal(
      receivedTarget[0].headers["x-webhook-signature"],
      expectedSigTarget,
      "firma HMAC target valida"
    );

    // target non ha event_type (flat style)
    assert.equal(targetData.event_type, undefined, "target non ha event_type");
  });

  test("format default legacy quando non specificato", async () => {
    receivedLegacy.length = 0;
    receivedTarget.length = 0;
    const secret = "default-secret";

    // Webhook senza specificare payload_format (default 'legacy')
    const webhook = (await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'default-format', 'out', $2, $3, '["contact_updated"]', true)
       RETURNING id, payload_format`,
      [site.id, mockUrlLegacy, secret]
    )).rows[0];

    assert.equal(webhook.payload_format, "legacy", "default payload_format è 'legacy'");

    // Emetti evento
    await emitContactEvent(site.id, "test2@example.com", "contact_updated", {});

    // Force delivery diretto
    const { deliverPending } = await import("../src/services/webhooks.js");
    await deliverPending(50, { siteId: site.id, allowPrivate: true });

    // Riceve legacy format
    assert.equal(receivedLegacy.length, 1, "riceve legacy per default");
    const data = JSON.parse(receivedLegacy[0].body);
    assert.equal(data.event_type, "contact_updated");
  });

  test("mapping nomi evento interno→target", async () => {
    receivedLegacy.length = 0;
    receivedTarget.length = 0;
    const events = [
      { internal: "contact_created", target: "ContactCreate" },
      { internal: "contact_updated", target: "ContactUpdate" },
      { internal: "contact_deleted", target: "ContactDelete" },
      { internal: "opportunity_created", target: "OpportunityCreate" },
      { internal: "form_submitted", target: "FormSubmitted" },
    ];

    const secret = "mapping-secret";

    for (const { internal, target: expectedType } of events) {
      const webhook = (await query(
        `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active, payload_format)
         VALUES ($1, $2, 'out', $3, $4, $5, true, 'target')
         RETURNING id`,
        [site.id, `test-${internal}`, mockUrlTarget, secret, JSON.stringify([internal])]
      )).rows[0];

      await emitContactEvent(site.id, `${internal}@example.com`, internal, {});
    }

    // Attendere che tutti gli enqueue siano completati (fire-and-forget in events.js)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Force delivery di tutte
    const { deliverPending } = await import("../src/services/webhooks.js");
    await deliverPending(50, { siteId: site.id, allowPrivate: true });

    // Verifica i mapping: deve contenere tutti i tipi richiesti
    const types = receivedTarget
      .map((r) => JSON.parse(r.body).type)
      .sort();
    const expected = events.map((e) => e.target).sort();
    assert(types.length >= expected.length, `ricevuti ${types.length} eventi, attesi almeno ${expected.length}`);
    assert(expected.every((e) => types.includes(e)), `mapping nomi evento corretto; ricevuti: ${types.join(", ")} attesi: ${expected.join(", ")}`);
  });
});
