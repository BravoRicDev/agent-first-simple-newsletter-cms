import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import http from "http";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerWebhooksRoutes } from "../src/routes/agent-webhooks.js";
import { publicWebhookRouter } from "../src/routes/public-webhooks.js";
import { enqueueForEvent, deliverPending, handleIncoming } from "../src/services/webhooks.js";

// Feature 35 — Webhook IN/OUT per collegare n8n: CRUD webhook, coda
// delivery OUT con firma HMAC e retry/backoff, endpoint pubblico IN con
// token e mapping azioni. Come prescritto, NON si importa agentRouter:
// il modulo agent è montato su un router locale con requireAuth +
// requireAgent, quello pubblico su app.use() senza auth.
describe("feature 35: webhook in/out", () => {
  let site, user, token, server, baseUrl;
  let deliveryServer, deliveryUrl, received;
  let failServer, failUrl;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const webhooksUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/webhooks${extra}`;
  const deliveriesUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/webhook-deliveries${extra}`;
  const publicUrl = (siteId, tok) => `${baseUrl}/webhooks/in/${siteId}/${tok}`;

  // Helper: attende che il server HTTP sia effettivamente in ascolto.
  async function waitForServer(srv) {
    const addr = srv.address();
    if (!addr) throw new Error("Server non in ascolto");
    // Prova a connettersi fino a 5 tentativi con backoff.
    for (let i = 0; i < 5; i++) {
      try {
        await fetch(`http://127.0.0.1:${addr.port}/health`, {
          signal: AbortSignal.timeout(200),
        }).catch(() => {}); // Il server risponde 404 su /health ma la connessione TCP riuscita basta.
        return;
      } catch {
        await new Promise(r => setTimeout(r, 50 * (i + 1)));
      }
    }
  }

  before(async () => {
    site = await createTestSite("CRM Webhook Test");
    const user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "webhook test", 30);
    token = created.token;

    // Server di cattura (200) e server che fallisce (500) su porta effimera.
    received = [];
    deliveryServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        received.push({ url: req.url, headers: req.headers, body: raw });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    failServer = http.createServer((req, res) => {
      req.resume();
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
    });
    await new Promise((resolve) => deliveryServer.listen(0, resolve));
    await new Promise((resolve) => failServer.listen(0, resolve));
    // Verifica che i server siano effettivamente in ascolto prima di proseguire.
    await waitForServer(deliveryServer);
    await waitForServer(failServer);
    deliveryUrl = `http://127.0.0.1:${deliveryServer.address().port}/hook/n8n`;
    failUrl = `http://127.0.0.1:${failServer.address().port}/hook/fail`;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerWebhooksRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use(publicWebhookRouter); // modulo pubblico SENZA auth
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    deliveryServer?.closeAllConnections?.();
    deliveryServer?.close();
    failServer?.closeAllConnections?.();
    failServer?.close();
    await closeDb();
  });

  // Helper: attende che una riga pending sia visibile nel DB, poi
  // chiama deliverPending. Risolve la race tra commit DB e query di
  // deliverPending che era la causa del flaky (~1/15 fallimenti).
  // markerOrEvent = nome del campo in payload->> (es. 'marker' o 'event_type').
  async function waitForPendingDelivery(markerOrEvent, value, limit = 50, opts = {}) {
    let rowFound = false;
    for (let i = 0; i < 15; i++) {
      const rows = (await query(
        `SELECT COUNT(*)::int AS n FROM webhook_deliveries
         WHERE status = 'pending' AND payload->>'${markerOrEvent}' = $1`,
        [value]
      )).rows;
      if (rows[0].n >= 1) { rowFound = true; break; }
      await new Promise(r => setTimeout(r, 80 * (i + 1)));
    }
    if (!rowFound) {
      // Fallback: forza deliverPending anche senza DB confirm.
      return await deliverPending(limit, { allowPrivate: true, ...opts });
    }
    return await deliverPending(limit, { allowPrivate: true, ...opts });
  }

  // Helper per deliverPending con retry (mantenuto per retrocompatibilità,
  // ma waitForPendingDelivery è il metodo robusto).
  async function deliverWithRetry(limit = 50, opts = {}, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      const result = await deliverPending(limit, { allowPrivate: true, ...opts });
      if (result.delivered >= 1) return result;
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
    return await deliverPending(limit, { allowPrivate: true, ...opts });
  }

  // ── (a) CRUD webhook in/out ────────────────────────────────────────────

  test("CRUD webhook out e in via route agent", async () => {
    const resOut = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n8n forms", direction: "out", url: deliveryUrl, secret: "s3cret", events: ["form_submitted"] }),
    });
    assert.equal(resOut.status, 200);
    const out = (await resOut.json()).webhook;
    assert.ok(out.id);
    assert.equal(out.direction, "out");
    assert.equal(out.name, "n8n forms");
    assert.deepEqual(out.events, ["form_submitted"]);

    const resIn = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n8n in", direction: "in", secret: "in-tok-a",
        events: { "lead.created": { action: "create_contact" } },
      }),
    });
    assert.equal(resIn.status, 200);
    const inbound = (await resIn.json()).webhook;
    assert.equal(inbound.direction, "in");
    assert.deepEqual(inbound.events, { "lead.created": { action: "create_contact" } });

    // Lista.
    const list = await fetch(webhooksUrl(), { headers: auth() });
    const { webhooks } = await list.json();
    const ids = webhooks.map((w) => w.id);
    assert.ok(ids.includes(out.id) && ids.includes(inbound.id));

    // Update (rename + disattiva).
    const upd = await fetch(webhooksUrl(`/${out.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n8n forms v2", active: false }),
    });
    assert.equal(upd.status, 200);
    const updated = (await upd.json()).webhook;
    assert.equal(updated.name, "n8n forms v2");
    assert.equal(updated.active, false);

    // Delete.
    const del = await fetch(webhooksUrl(`/${inbound.id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, true);
    const after = await fetch(webhooksUrl(), { headers: auth() });
    assert.ok(!(await after.json()).webhooks.some((w) => w.id === inbound.id));

    // Validazioni: url non-http per out → 400; nome vuoto → 400.
    const badUrl = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", direction: "out", url: "ftp://nope", events: ["a"] }),
    });
    assert.equal(badUrl.status, 400);
    const noName = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "in" }),
    });
    assert.equal(noName.status, 400);
  });

  // ── (b) enqueueForEvent (chiamata diretta al servizio) ─────────────────

  test("enqueueForEvent accoda una delivery pending", async () => {
    const res = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n8n form events", direction: "out", url: deliveryUrl, secret: "s3cret",
        events: ["form_submitted", "quote_signed"],
      }),
    });
    const { webhook } = await res.json();
    assert.equal(res.status, 200);

    const result = await enqueueForEvent(site.id, "form_submitted", { form_slug: "lead", marker: "deliv-b" });
    assert.equal(result.queued, 1);

    const rows = (await query(
      "SELECT * FROM webhook_deliveries WHERE webhook_id = $1 AND event_type = $2",
      [webhook.id, "form_submitted"]
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].attempts, 0);
    assert.equal(rows[0].payload.form_slug, "lead");

    // Evento non mappato → nessuna delivery.
    const skipped = await enqueueForEvent(site.id, "page_view", {});
    assert.equal(skipped.queued, 0);
  });

  // ── (c)+(d) deliverPending: 200, header evento, firma HMAC ─────────────
  //
  // NOTA: questo test usa waitForPendingDelivery che prima polla il DB fino a
  // 15 tentativi per accertarsi che la riga pending sia visibile, poi chiama
  // deliverPending. Risolve definitivamente la race tra commit DB e query che
  // causava il flaky (~1/15 fallimenti col vecchio deliverWithRetry a 3 tentativi).

  test("deliverPending spedisce con X-Webhook-Event e firma HMAC verificabile", async () => {
    const result = await waitForPendingDelivery("marker", "deliv-b", 50);
    assert.ok(result.delivered >= 1, `delivered=${result.delivered} (dopo attesa pending)`);

    const captured = received.find((req) => req.body.includes("deliv-b"));
    assert.ok(captured, "il server ha ricevuto il body della delivery (b)");
    assert.equal(captured.headers["x-webhook-event"], "form_submitted");
    assert.equal(captured.headers["content-type"], "application/json");
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.event_type, "form_submitted");
    assert.equal(parsed.payload.form_slug, "lead");

    // Firma HMAC-SHA256 del body grezzo con la secret del webhook.
    const expected = crypto.createHmac("sha256", "s3cret").update(captured.body).digest("hex");
    assert.equal(captured.headers["x-webhook-signature"], expected);

    const rows = (await query(
      "SELECT status FROM webhook_deliveries WHERE event_type = 'form_submitted' AND payload->>'marker' = 'deliv-b'"
    )).rows;
    assert.ok(rows.length >= 1, `almeno una delivery consegnata (trovate ${rows.length})`);
    assert.ok(rows.every((r) => r.status === "sent"), "tutte le delivery con marker deliv-b sono sent");
  });

  // ── (e) retry/backoff: 500 → attempts++ e next_attempt_at futuro ──────

  test("delivery fallita resta pending con backoff (2^attempts minuti)", async () => {
    const res = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n8n fail", direction: "out", url: failUrl,
        events: ["quote_signed"],
      }),
    });
    const { webhook } = await res.json();
    await enqueueForEvent(site.id, "quote_signed", { marker: "deliv-e" });

    // Retry/backoff verificato con chiamata diretta allowPrivate (server locale).
    const outcome = await deliverPending(50, { allowPrivate: true });
    assert.ok(outcome.failed >= 1, JSON.stringify(outcome));

    const rows = (await query(
      "SELECT * FROM webhook_deliveries WHERE webhook_id = $1 AND payload->>'marker' = 'deliv-e'",
      [webhook.id]
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending", "resta pending per il retry");
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].last_error, "HTTP 500");
    assert.ok(new Date(rows[0].next_attempt_at).getTime() > Date.now() + 60 * 1000,
      "next_attempt_at nel futuro (2^1 = 2 minuti)");

    // La run forzata la si vede anche nello storico deliveries.
    const list = await fetch(deliveriesUrl("?status=pending"), { headers: auth() });
    const { deliveries } = await list.json();
    assert.ok(deliveries.some((d) => d.payload?.marker === "deliv-e"));
  });

  // ── (e2) SSRF: webhook out verso IP privato/loopback bloccato ──────────

  test("SSRF: webhook verso loopback bloccato dalla route /run (safeFetch)", async () => {
    const wh = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ssrf trap", direction: "out", url: "http://127.0.0.1:9/x",
        events: ["form_submitted"],
      }),
    });
    assert.equal(wh.status, 200);
    const { webhook } = await wh.json();

    const ins = await query(
      `INSERT INTO webhook_deliveries (webhook_id, site_id, event_type, payload, status, next_attempt_at)
       VALUES ($1, $2, 'form_submitted', $3, 'pending', NOW() - interval '1 minute') RETURNING id`,
      [webhook.id, site.id, JSON.stringify({ marker: "deliv-ssrf" })]
    );

    const run = await fetch(deliveriesUrl("/run"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 50 }),
    });
    assert.equal(run.status, 200);

    const rows = (await query("SELECT * FROM webhook_deliveries WHERE id = $1", [ins.rows[0].id])).rows;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].attempts >= 1, "tentativo registrato");
    assert.match(rows[0].last_error, /non consentito|Indirizzo IP/i,
      "il fetch verso loopback viene bloccato da safeFetch (SSRF guard)");
  });

  // ── (f) handleIncoming: mapping create_contact ─────────────────────────

  test("handleIncoming con token valido crea il contatto", async () => {
    const res = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n8n lead in", direction: "in", secret: "in-tok-f",
        events: { "lead.created": { action: "create_contact", config: { tags: ["webhook-lead"] } } },
      }),
    });
    const { webhook } = await res.json();

    const email = uniqueEmail("lead");
    const outcome = await handleIncoming(site.id, "in-tok-f", { event_type: "lead.created", email });
    assert.deepEqual(outcome, { received: true, actions: 1 });

    const rows = (await query("SELECT * FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].tags.includes("webhook-lead"));

    // Token errato → null (la route risponde 401).
    assert.equal(await handleIncoming(site.id, "sbagliato", { event_type: "lead.created", email }), null);
    // Webhook disattivato → null.
    await query("UPDATE webhooks SET active = false WHERE id = $1", [webhook.id]);
    assert.equal(await handleIncoming(site.id, "in-tok-f", { event_type: "lead.created", email }), null);
  });

  // ── (g)+(h) route pubblica: 401 con token errato, 200 con token valido ─

  test("route pubblica: 401 token errato, 200 token valido", async () => {
    // Token errato → 401.
    const bad = await fetch(publicUrl(site.id, "token-inesistente"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "lead.created", email: "x@example.test" }),
    });
    assert.equal(bad.status, 401);

    // Token valido → 200 {ok:true}.
    const res = await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "pubblico in", direction: "in", secret: "pub-tok-h",
        events: { "lead.created": { action: "create_contact" } },
      }),
    });
    assert.equal(res.status, 200);

    const email = uniqueEmail("pub");
    const good = await fetch(publicUrl(site.id, "pub-tok-h"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "lead.created", email }),
    });
    assert.equal(good.status, 200);
    const body = await good.json();
    assert.equal(body.ok, true);
    assert.equal(body.actions, 1);

    const rows = (await query("SELECT * FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows;
    assert.equal(rows.length, 1);
  });

  // ── (i) handleIncoming: emit_event → evento nel bus interno ────────────

  test("handleIncoming emit_event ri-emette nel bus (contatto + contact_events)", async () => {
    await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n8n emit", direction: "in", secret: "in-tok-i",
        events: { "quote.signed": { action: "emit_event", config: { event_type: "quote_signed" } } },
      }),
    });

    const email = uniqueEmail("emit");
    const outcome = await handleIncoming(site.id, "in-tok-i", {
      event_type: "quote.signed", email, quote_id: 42,
    });
    assert.deepEqual(outcome, { received: true, actions: 1 });

    const rows = (await query(
      "SELECT * FROM contact_events WHERE site_id = $1 AND email = $2 AND event_type = 'quote_signed'",
      [site.id, email]
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.quote_id, 42);
    assert.ok(rows[0].payload.webhook_id, "payload arricchito con webhook_id");
  });

  // ── (k) handleIncoming: add_tag e create_task ──────────────────────────

  test("handleIncoming add_tag e create_task", async () => {
    await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n8n task", direction: "in", secret: "in-tok-k",
        events: {
          "tag.me": { action: "add_tag", config: { tag: "da-webhook" } },
          "todo.now": { action: "create_task", config: { title: "Chiama subito" } },
        },
      }),
    });

    const email = uniqueEmail("task");
    await handleIncoming(site.id, "in-tok-k", { event_type: "tag.me", email });
    const contact = (await query("SELECT tags FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.ok(contact && contact.tags.includes("da-webhook"));

    await handleIncoming(site.id, "in-tok-k", { event_type: "todo.now", email });
    const tasks = (await query(
      "SELECT * FROM tasks WHERE site_id = $1 AND email = $2 AND title = 'Chiama subito'",
      [site.id, email]
    )).rows;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "open");
  });

  // ── (l) aggancio end-to-end: emitContactEvent → delivery via events.js ─

  test("emitContactEvent inoltra al webhook out (aggancio in events.js)", async () => {
    await fetch(webhooksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n8n end2end", direction: "out", url: deliveryUrl, secret: "e2e",
        events: ["form_submitted"],
      }),
    });
    const email = uniqueEmail("e2e");
    const { emitContactEvent } = await import("../src/services/events.js");
    await emitContactEvent(site.id, email, "form_submitted", { marker: "deliv-l", form_slug: "contatti" });

    const rows = (await query(
      "SELECT * FROM webhook_deliveries WHERE payload->>'marker' = 'deliv-l' AND status = 'pending'"
    )).rows;
    assert.ok(rows.length >= 1, `l'evento ha accodato almeno una delivery pending (trovate ${rows.length})`);

    // Usa waitForPendingDelivery per mitigare la race tra commit DB e fetch.
    const result = await waitForPendingDelivery("marker", "deliv-l", 50);
    assert.ok(result.delivered >= 1);
    // Più webhook out possono matchare lo stesso evento: cerca la delivery
    // firmata con la secret 'e2e' del webhook end2end, non la prima in ordine.
    const candidates = received.filter((req) => req.body.includes("deliv-l"));
    const captured = candidates.find(
      (req) => req.headers["x-webhook-signature"] === crypto.createHmac("sha256", "e2e").update(req.body).digest("hex")
    );
    assert.ok(captured, "delivery end-to-end firmata con la secret e2e arrivata al server");
    assert.equal(captured.headers["x-webhook-event"], "form_submitted");
    const expected = crypto.createHmac("sha256", "e2e").update(captured.body).digest("hex");
    assert.equal(captured.headers["x-webhook-signature"], expected);
  });
});
