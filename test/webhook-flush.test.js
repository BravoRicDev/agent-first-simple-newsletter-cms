import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import http from "http";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { runSchedulerTick } from "../src/services/scheduler.js";

// Bug: deliverPending() (webhooks.js) esisteva ma nessuno la chiamava dal
// tick dello scheduler — l'unico trigger era il POST manuale
// .../webhook-deliveries/run. Le delivery restavano 'pending' per sempre.
// Fix: schedulerTick() ora chiama deliverPending() (fail-soft, come gli
// altri job). Qui verifichiamo che un tick reale flush una delivery pending
// verso un server HTTP locale mock, usando l'opzione { webhookAllowPrivate }
// (solo per i test) per bypassare il blocco SSRF su localhost.
describe("scheduler: flush automatico webhook OUT pending", () => {
  let site, mockServer, mockUrl, receivedRequests;

  before(async () => {
    site = await createTestSite("Webhook Flush Test");

    // Igiene ambiente di test: deliverPending() (chiamata dal tick, come da
    // fix) processa TUTTE le delivery pending del DB, non solo quelle del
    // sito di test — il container Postgres di test è condiviso e a lunga
    // vita, con backlog di delivery 'pending' verso host irraggiungibili
    // lasciate da altre suite (es. onda1-webhook-out*.test.js verso
    // n8n.example.test). Rimuoviamo solo debris più vecchio di 10 minuti:
    // nessuna suite in corso in questo momento può aver inserito righe così
    // vecchie, quindi non tocca stato di test concorrenti.
    await query("DELETE FROM webhook_deliveries WHERE status = 'pending' AND created_at < NOW() - INTERVAL '10 minutes'");

    receivedRequests = [];
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        receivedRequests.push({ headers: req.headers, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => {
      mockServer.listen(0, "127.0.0.1", resolve);
    });
    mockUrl = `http://127.0.0.1:${mockServer.address().port}/hook`;
  });

  after(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
    await closeDb();
  });

  test("delivery pending diventa 'sent' dopo un tick dello scheduler", async () => {
    const secret = "flush-secret";
    const webhook = (await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'flush-test', 'out', $2, $3, '["manual_test"]', true) RETURNING id`,
      [site.id, mockUrl, secret]
    )).rows[0];

    const delivery = (await query(
      `INSERT INTO webhook_deliveries (webhook_id, site_id, event_type, payload)
       VALUES ($1, $2, 'manual_test', $3) RETURNING id`,
      [webhook.id, site.id, JSON.stringify({ foo: "bar" })]
    )).rows[0];

    // Il tick reale dello scheduler: senza il fix, deliverPending() non
    // viene mai chiamato e la delivery resta 'pending' all'infinito.
    await runSchedulerTick({ webhookAllowPrivate: true });

    const row = (await query(
      "SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = $1",
      [delivery.id]
    )).rows[0];
    assert.equal(row.status, "sent", `delivery deve risultare 'sent', errore: ${row.last_error}`);
    assert.equal(row.attempts, 1);

    assert.equal(receivedRequests.length, 1, "il mock server deve aver ricevuto esattamente 1 richiesta");
    const received = receivedRequests[0];
    const parsedBody = JSON.parse(received.body);
    assert.equal(parsedBody.event_type, "manual_test");
    assert.deepEqual(parsedBody.payload, { foo: "bar" });

    const expectedSignature = crypto.createHmac("sha256", secret).update(received.body).digest("hex");
    assert.equal(received.headers["x-webhook-signature"], expectedSignature, "firma HMAC valida");
  });

  test("endpoint manuale esistente (deliverPending diretto) resta invariato", async () => {
    // Non rimosso dal fix: verifica che deliverPending() sia ancora
    // chiamabile direttamente (come fa POST .../webhook-deliveries/run).
    const { deliverPending } = await import("../src/services/webhooks.js");
    const secret = "manual-secret";
    const webhook = (await query(
      `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
       VALUES ($1, 'manual-test', 'out', $2, $3, '["manual_test"]', true) RETURNING id`,
      [site.id, mockUrl, secret]
    )).rows[0];
    const delivery = (await query(
      `INSERT INTO webhook_deliveries (webhook_id, site_id, event_type, payload)
       VALUES ($1, $2, 'manual_test', '{}') RETURNING id`,
      [webhook.id, site.id]
    )).rows[0];

    const result = await deliverPending(50, { siteId: site.id, allowPrivate: true });
    assert.equal(result.delivered, 1);

    const row = (await query("SELECT status FROM webhook_deliveries WHERE id = $1", [delivery.id])).rows[0];
    assert.equal(row.status, "sent");
  });
});
