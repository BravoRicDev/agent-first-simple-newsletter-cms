import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { enqueueForEvent, deliverPending } from "../src/services/webhooks.js";

// ─────────────────────────────────────────────────────────────────────────
// WEBHOOK OUT — e2e delivery verso server HTTP (simulazione n8n):
//   - delivery con firma HMAC-SHA256
//   - retry su 5xx (backoff esponenziale)
//   - max tentativi → failed
//   - successo su retry dopo fallimento iniziale
//   - isolamento tenant
// ─────────────────────────────────────────────────────────────────────────
describe("WEBHOOK OUT — e2e delivery verso n8n (HTTP + HMAC)", () => {
  let server, baseUrl;
  let siteA, siteB;
  const received = [];

  // Server HTTP che simula n8n: registra ogni POST ricevuto e risponde
  // in base alla route.
  before(async () => {
    siteA = await createTestSite("WH N8N Tenant A");
    siteB = await createTestSite("WH N8N Tenant B");

    // Pulisci webhook_deliveries residue
    await query("DELETE FROM webhook_deliveries WHERE site_id IN ($1, $2)", [siteA.id, siteB.id]);
    await query("DELETE FROM webhooks WHERE site_id IN ($1, $2)", [siteA.id, siteB.id]);

    // Mappa route → risposta HTTP (status, body)
    const routes = {};

    // Route prenotabili:
    // - /n8n/hmac    → 200 sempre (test HMAC)
    // - /n8n/retry   → 503 prima chiamata, poi 200
    // - /n8n/fail    → 503 sempre (max tentativi)
    // - /n8n/isolation → 200 sempre (tenant B)
    // - /n8n/delayed → 200 solo se X-Delivery-Id matcha

    // App n8n simulator
    const n8nApp = express();
    n8nApp.use(express.json());
    n8nApp.use((req, res) => {
      if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

      const deliveryId = req.headers["x-delivery-id"] || "";
      const signature = req.headers["x-webhook-signature"] || "";
      const eventType = req.headers["x-webhook-event"] || "";

      const entry = {
        method: req.method,
        path: req.path,
        headers: {
          "content-type": req.headers["content-type"],
          "x-webhook-signature": signature,
          "x-webhook-event": eventType,
          "x-delivery-id": deliveryId,
        },
        body: req.body,
        receivedAt: Date.now(),
      };
      received.push(entry);

      // Route matching
      if (req.path === "/n8n/hmac") {
        return res.status(200).json({ ok: true });
      }
      if (req.path === "/n8n/retry") {
        // Conta quante volte questo è stato chiamato per questo webhook
        const count = received.filter(e => e.path === "/n8n/retry").length;
        if (count <= 1) {
          return res.status(503).json({ error: "Service Unavailable" });
        }
        return res.status(200).json({ ok: true });
      }
      if (req.path === "/n8n/fail") {
        return res.status(503).json({ error: "Always failing" });
      }
      if (req.path === "/n8n/isolation") {
        return res.status(200).json({ ok: true });
      }
      if (req.path === "/n8n/delayed") {
        // Deliberately slow response
        return res.status(200).json({ ok: true });
      }

      res.status(404).json({ error: "unknown route" });
    });

    await new Promise((resolve) => {
      server = n8nApp.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  // ── Helper: crea webhook OUT per un tenant ──────────────────────────
  async function createOutWebhook(siteId, suffix, events = ["contact_created"]) {
    const secret = `whsec_${crypto.randomBytes(8).toString("hex")}`;
    await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, $2, 'out', $3, $4, $5, true)`,
      [siteId, `wh-n8n-${suffix}`, `${baseUrl}/n8n/${suffix}`, secret, JSON.stringify(events)]
    );
    return secret;
  }

  // ── Helper: crea un contatto per innescare eventi ──────────────────
  async function createContactTrigger(siteId, email) {
    // Schema contatti: site_id, email (UNIQUE), tags, status, notes ...
    // Nessuna colonna `name` — il nome è opzionale, usiamo email
    const { rows } = await query(
      `INSERT INTO contacts (site_id, email)
       VALUES ($1, $2)
       ON CONFLICT (site_id, email) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [siteId, email]
    );
    return rows[0].id;
  }

  // ── Helper: pulisci delivery residue ───────────────────────────────
  async function clearDeliveries(siteId) {
    await query("DELETE FROM webhook_deliveries WHERE site_id = $1", [siteId]);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1 — HMAC signature: la firma HMAC-SHA256 deve essere presente
  // nell'header X-Webhook-Signature e corrispondere al secret.
  // ═══════════════════════════════════════════════════════════════════
  test("HMAC signature: header X-Webhook-Signature presente e valido", async () => {
    await clearDeliveries(siteA.id);
    received.length = 0;

    const secret = await createOutWebhook(siteA.id, "hmac", ["contact_created"]);
    const email = `hmac-test-${Date.now()}@example.test`;
    await createContactTrigger(siteA.id, email);

    // Enqueue evento
    const { queued } = await enqueueForEvent(siteA.id, "contact_created", { email, name: "HMAC Test" });
    assert.equal(queued, 1, "deve accodare 1 delivery");

    // Deliver con allowPrivate (localhost)
    const result = await deliverPending(50, { siteId: siteA.id, allowPrivate: true });
    assert.equal(result.delivered, 1, "deve consegnare 1 delivery");
    assert.equal(result.failed, 0, "nessun fallimento");
    assert.equal(result.remaining, 0, "nessuna delivery residue");

    // Verifica che l'n8n simulator abbia ricevuto la richiesta
    assert.ok(received.length >= 1, "almeno 1 richiesta ricevuta da n8n simulator");

    const entry = received.find(e => e.body?.event_type === "contact_created");
    assert.ok(entry, "richiesta contact_created ricevuta");
    assert.ok(entry.headers["x-webhook-signature"], "header X-Webhook-Signature presente");

    // Verifica firma HMAC
    const bodyStr = JSON.stringify(entry.body);
    const expectedSig = crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");
    assert.equal(entry.headers["x-webhook-signature"], expectedSig, "HMAC signature deve corrispondere");

    // Verifica header ausiliari
    assert.equal(entry.headers["x-webhook-event"], "contact_created", "X-Webhook-Event presente");
    assert.equal(entry.body.event_type, "contact_created", "event_type nel body corretto");
    assert.ok(entry.body.payload?.email, "payload.email presente");
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2 — Retry: se n8n risponde 5xx, la delivery viene riprogrammata
  // con backoff. Alla seconda chiamata, risponde 200 e la delivery passa.
  // ═══════════════════════════════════════════════════════════════════
  test("retry: se n8n risponde 503, la delivery viene ritentata e poi passa", async () => {
    await clearDeliveries(siteA.id);
    received.length = 0;

    const secret = await createOutWebhook(siteA.id, "retry", ["contact_created"]);
    const email = `retry-test-${Date.now()}@example.test`;
    await createContactTrigger(siteA.id, email);

    // Enqueue evento
    await enqueueForEvent(siteA.id, "contact_created", { email, name: "Retry Test" });

    // Primo delivery: n8n risponde 503 → la delivery fallisce ma non è failed
    // (viene riprogrammata con backoff)
    const result1 = await deliverPending(50, { siteId: siteA.id, allowPrivate: true });
    assert.equal(result1.failed, 1, "primo tentativo deve fallire (503)");

    // Verifica che la delivery abbia attempts=1 e next_attempt_at in futuro
    const delivery = (await query(
      "SELECT attempts, status, next_attempt_at FROM webhook_deliveries WHERE site_id = $1 AND event_type = 'contact_created' ORDER BY id DESC LIMIT 1",
      [siteA.id]
    )).rows[0];
    assert.equal(delivery.status, "pending", "status deve restare pending (retry)");
    assert.equal(delivery.attempts, 1, "attempts deve essere 1");
    assert.ok(delivery.next_attempt_at > new Date(), "next_attempt_at deve essere in futuro (backoff)");

    // Forza next_attempt_at al passato per simulare il passaggio del backoff
    await query(
      "UPDATE webhook_deliveries SET next_attempt_at = NOW() - interval '1 minute' WHERE site_id = $1 AND event_type = 'contact_created'",
      [siteA.id]
    );

    // Secondo delivery: n8n ora risponde 200
    const result2 = await deliverPending(50, { siteId: siteA.id, allowPrivate: true });
    assert.equal(result2.delivered, 1, "secondo tentativo deve riuscire");
    assert.equal(result2.failed, 0);

    // Il n8n simulator deve aver ricevuto 2 chiamate per /n8n/retry
    const retryEntries = received.filter(e => e.path === "/n8n/retry");
    assert.ok(retryEntries.length >= 2, "almeno 2 richieste su /n8n/retry");
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3 — Max attempts: dopo MAX_ATTEMPTS tentativi falliti, la
  // delivery va in status 'failed'.
  // ═══════════════════════════════════════════════════════════════════
  test("max attempt: dopo MAX tentativi falliti delivery va in 'failed'", async () => {
    await clearDeliveries(siteA.id);
    received.length = 0;

    // Crea webhook verso /n8n/fail (503 sempre)
    await createOutWebhook(siteA.id, "fail", ["contact_created"]);
    const email = `fail-test-${Date.now()}@example.test`;
    await createContactTrigger(siteA.id, email);
    await enqueueForEvent(siteA.id, "contact_created", { email, name: "Fail Test" });

    // Simula i 5 tentativi massimi forzando next_attempt_at
    for (let attempt = 1; attempt <= 5; attempt++) {
      // Forza next_attempt_at al passato
      await query(
        "UPDATE webhook_deliveries SET next_attempt_at = NOW() - interval '1 minute' WHERE site_id = $1 AND event_type = 'contact_created' AND status = 'pending'",
        [siteA.id]
      );
      const r = await deliverPending(50, { siteId: siteA.id, allowPrivate: true });
      // L'ultimo tentativo (5°) setta lo status a 'failed'
    }

    // Verifica che la delivery sia in status 'failed'
    const delivery = (await query(
      "SELECT status, attempts FROM webhook_deliveries WHERE site_id = $1 AND event_type = 'contact_created' ORDER BY id DESC LIMIT 1",
      [siteA.id]
    )).rows[0];
    assert.equal(delivery.status, "failed", "status deve essere 'failed' dopo max tentativi");
    assert.ok(delivery.attempts >= 5, "attempts deve essere >= 5");
  });

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4 — Isolamento tenant: gli eventi di Tenant A NON generano
  // delivery su webhook di Tenant B e viceversa.
  // ═══════════════════════════════════════════════════════════════════
  test("isolamento tenant: webhook B non riceve eventi di A", async () => {
    await clearDeliveries(siteA.id);
    await clearDeliveries(siteB.id);
    // Pulisci anche i webhook su A (potrebbero esserci residui da test precedenti)
    await query("DELETE FROM webhooks WHERE site_id = $1", [siteA.id]);
    received.length = 0;

    // Webhook solo su B per isolation
    const secretB = await createOutWebhook(siteB.id, "isolation", ["contact_created"]);

    // Crea evento su A
    const email = `iso-test-${Date.now()}@example.test`;
    await createContactTrigger(siteA.id, email);
    await enqueueForEvent(siteA.id, "contact_created", { email, name: "Isolation Test" });

    // Deliver SOLO per siteA (non siteB)
    const result = await deliverPending(50, { siteId: siteA.id, allowPrivate: true });
    // Nessun webhook su A → nessun delivery (deliverPending ritorna {delivered:0,...})
    assert.equal(result.delivered, 0, "nessun delivery da A (nessun webhook su A)");

    // B non dovrebbe avere ricevuto nulla
    const bEntries = received.filter(e => e.path === "/n8n/isolation");
    assert.equal(bEntries.length, 0, "tenant B non deve ricevere eventi di A");

    // Ora crea evento su B
    const emailB = `iso-b-${Date.now()}@example.test`;
    await createContactTrigger(siteB.id, emailB);
    await enqueueForEvent(siteB.id, "contact_created", { email: emailB, name: "B Isolation" });

    const resultB = await deliverPending(50, { siteId: siteB.id, allowPrivate: true });
    assert.equal(resultB.delivered, 1, "B deve consegnare 1 delivery");

    const bEntries2 = received.filter(e => e.path === "/n8n/isolation" && e.body?.payload?.email === emailB);
    assert.ok(bEntries2.length >= 1, "tenant B deve ricevere i propri eventi");
  });
});