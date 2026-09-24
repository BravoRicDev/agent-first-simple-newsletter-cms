import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { deliverPending } from "../src/services/webhooks.js";

// Migrazione pg_advisory_lock -> FOR UPDATE SKIP LOCKED (v2, webhooks.js):
// prima di questo round, un lock advisory globale (74812001) faceva sì che,
// se due nodi chiamavano deliverPending() nello stesso istante, uno dei due
// tornasse subito con { skipped: true } senza fare nulla. Ora entrambi
// possono lavorare in parallelo: la sicurezza (mai la stessa riga consegnata
// due volte) è garantita SOLO dal claim FOR UPDATE SKIP LOCKED già esistente
// su webhook_deliveries. Questo test prova esattamente questa invariante,
// chiamando deliverPending() due volte in parallelo su un batch di delivery
// pending verso un mock server locale.
describe("webhooks: deliverPending concorrente (senza lock globale)", () => {
  let site, mockServer, mockUrl, receivedCount;

  before(async () => {
    site = await createTestSite("Webhook Deliver Concurrency Test");
    receivedCount = 0;
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        receivedCount++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    mockUrl = `http://127.0.0.1:${mockServer.address().port}/hook`;
  });

  after(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
    await closeDb();
  });

  test("due chiamate parallele a deliverPending() non consegnano mai due volte la stessa riga", async () => {
    const webhook = (await query(
      `INSERT INTO webhooks (site_id, name, direction, url, events, active)
       VALUES ($1, 'concurrency-test', 'out', $2, '["manual_test"]', true) RETURNING id`,
      [site.id, mockUrl]
    )).rows[0];

    const N = 20;
    const deliveryIds = [];
    for (let i = 0; i < N; i++) {
      const row = (await query(
        `INSERT INTO webhook_deliveries (webhook_id, site_id, event_type, payload)
         VALUES ($1, $2, 'manual_test', $3) RETURNING id`,
        [webhook.id, site.id, JSON.stringify({ i })]
      )).rows[0];
      deliveryIds.push(row.id);
    }

    // Simula due nodi Active/Active che drainano la coda nello stesso istante.
    const [resA, resB] = await Promise.all([
      deliverPending(50, { siteId: site.id, allowPrivate: true }),
      deliverPending(50, { siteId: site.id, allowPrivate: true }),
    ]);

    assert.equal(resA.skipped, undefined, "nessuna delle due chiamate deve essere saltata da un lock globale");
    assert.equal(resB.skipped, undefined, "nessuna delle due chiamate deve essere saltata da un lock globale");

    const rows = (await query(
      "SELECT id, status, attempts FROM webhook_deliveries WHERE id = ANY($1::int[])",
      [deliveryIds]
    )).rows;
    assert.equal(rows.length, N);
    for (const row of rows) {
      assert.equal(row.status, "sent", `delivery ${row.id} deve essere 'sent'`);
      assert.equal(row.attempts, 1, `delivery ${row.id} deve avere esattamente 1 tentativo (mai consegnata due volte)`);
    }
    assert.equal(receivedCount, N, "il mock server deve aver ricevuto esattamente N richieste, mai duplicate");
    assert.equal((resA.delivered || 0) + (resB.delivered || 0), N, "le N delivery sono state ripartite (non duplicate) tra le due chiamate");
  });
});
