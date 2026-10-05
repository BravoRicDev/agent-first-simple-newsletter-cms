import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import config from "../src/config.js";
import pool, { query } from "../src/db.js";
import { createTestSite } from "./helpers.js";
import { publicPaymentsRouter } from "../src/routes/public-payments.js";
import { stripeWebhookRouter, setStripePaymentLinkFetcher } from "../src/routes/stripe-webhook.js";

// ─────────────────────────────────────────────────────────────────────────
// Sicurezza pagamenti (TASK A):
//   1) POST /pay/:token/confirm NON marca paid se il link ha stripe_url
//      valorizzato (il pagamento reale avviene su Stripe) e in
//      NODE_ENV=production la modalità simulata è spenta del tutto.
//   2) POST /webhooks/stripe: firma HMAC-SHA256 verificata sul body RAW,
//      400 su firma errata, markPaidByToken su firma corretta.
// ─────────────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "whsec_test_secret_1234567890";

async function createLink(siteId, { title = "Link test", amount = 100, status = "draft", stripe_url = "" } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const result = await query(
    `INSERT INTO payment_links (site_id, title, amount, currency, status, stripe_url, token)
     VALUES ($1, $2, $3, 'EUR', $4, $5, $6) RETURNING *`,
    [siteId, title, amount, status, stripe_url, token]
  );
  return result.rows[0];
}

function sign(payload, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://localhost:${server.address().port}` };
}

// Setup condiviso: un solo sito, due server (uno per public-payments, uno per stripe-webhook)
let site;
let payServer, payBaseUrl;
let whServer, whBaseUrl;
const originalNodeEnv = process.env.NODE_ENV;
const originalSecret = config.stripeWebhookSecret;

// Creiamo un fetcher mock che i test possono sovrascrivere
let mockTokenValue = null;
const stubFetcher = async (paymentLinkId) => {
  return {
    id: paymentLinkId,
    metadata: { token: mockTokenValue },
  };
};

before(async () => {
  site = await createTestSite("Payments Security");

  // Server per /pay/:token/confirm
  const payApp = express();
  payApp.use((req, res, next) => { res.locals.t = (k) => k; next(); });
  payApp.use(publicPaymentsRouter);
  payApp.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  ({ server: payServer, baseUrl: payBaseUrl } = await listen(payApp));

  // Server per /webhooks/stripe
  config.stripeWebhookSecret = WEBHOOK_SECRET;
  const whApp = express();
  whApp.use("/webhooks/stripe", stripeWebhookRouter);
  whApp.use(express.json({ limit: "50mb" }));
  whApp.use((req, res, next) => { res.locals.t = (k) => k; next(); });
  whApp.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  ({ server: whServer, baseUrl: whBaseUrl } = await listen(whApp));

  // Imposta lo stub fetcher
  setStripePaymentLinkFetcher(stubFetcher);
});

after(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  config.stripeWebhookSecret = originalSecret;
  payServer?.closeAllConnections?.();
  payServer?.close();
  whServer?.closeAllConnections?.();
  whServer?.close();
  // Ripristina il fetcher reale
  setStripePaymentLinkFetcher(null);
  await pool.end();
});

describe("pagamenti: sicurezza di /pay/:token/confirm", () => {
  beforeEach(() => { process.env.NODE_ENV = "test"; });
  afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });

  test("confirm su link con stripe_url → 404 e nessun cambio di stato", async () => {
    const link = await createLink(site.id, { status: "active", stripe_url: "https://buy.stripe.com/test_abc" });

    const res = await fetch(`${payBaseUrl}/pay/${link.token}/confirm`, { method: "POST", redirect: "manual" });
    assert.equal(res.status, 404);

    const row = (await query("SELECT status, paid_at FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "active", "lo stato non deve cambiare");
    assert.equal(row.paid_at, null, "paid_at non deve essere valorizzato");
  });

  test("confirm su link senza stripe_url in dev/test continua a marcare paid", async () => {
    const link = await createLink(site.id, { status: "draft", stripe_url: "" });

    const res = await fetch(`${payBaseUrl}/pay/${link.token}/confirm`, { method: "POST", redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") || "", new RegExp(`/pay/${link.token}$`));

    const row = (await query("SELECT status FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "paid");
  });

  test("in production la conferma simulata è disattivata (404) e il form non compare", async () => {
    process.env.NODE_ENV = "production";
    const link = await createLink(site.id, { status: "draft", stripe_url: "" });

    const res = await fetch(`${payBaseUrl}/pay/${link.token}/confirm`, { method: "POST", redirect: "manual" });
    assert.equal(res.status, 404);

    const row = (await query("SELECT status, paid_at FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "draft", "in produzione nessuno stato cambia");
    assert.equal(row.paid_at, null);

    const page = await fetch(`${payBaseUrl}/pay/${link.token}`);
    assert.equal(page.status, 404);
    const html = await page.text();
    assert.doesNotMatch(html, /Conferma pagamento/);
  });
});

describe("pagamenti: webhook Stripe", () => {
  const post = (payload, signature) => fetch(`${whBaseUrl}/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload,
  });

  test("firma errata → 400 e il link resta invariato", async () => {
    const link = await createLink(site.id, { status: "active", stripe_url: "https://buy.stripe.com/test_bad" });
    const payload = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { payment_status: "paid", payment_link: "pl_bad" } },
    });

    mockTokenValue = link.token;

    const res = await post(payload, sign(payload, "whsec_secret_sbagliato"));
    assert.equal(res.status, 400);

    const row = (await query("SELECT status FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "active");
  });

  test("firma valida su checkout.session.completed → marca paid", async () => {
    const link = await createLink(site.id, { status: "active", stripe_url: "https://buy.stripe.com/test_ok" });
    const payload = JSON.stringify({
      id: "evt_2",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_status: "paid", payment_link: "pl_ok" } },
    });

    mockTokenValue = link.token;

    const res = await post(payload, sign(payload));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });

    const row = (await query("SELECT status, paid_at FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "paid");
    assert.ok(row.paid_at);
  });

  test("con payment_status !== 'paid' lo stato NON cambia", async () => {
    const link = await createLink(site.id, { status: "active", stripe_url: "https://buy.stripe.com/test_not_paid" });
    const payload = JSON.stringify({
      id: "evt_not_paid",
      type: "checkout.session.completed",
      data: { object: { id: "cs_2", payment_status: "unpaid", payment_link: "pl_not_paid" } },
    });

    mockTokenValue = link.token;

    const res = await post(payload, sign(payload));
    assert.equal(res.status, 200);

    const row = (await query("SELECT status FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "active");
  });

  test("timestamp fuori tolleranza (300s) → 400", async () => {
    const link = await createLink(site.id, { status: "active", stripe_url: "https://buy.stripe.com/test_old" });
    const payload = JSON.stringify({
      id: "evt_4",
      type: "checkout.session.completed",
      data: { object: { payment_status: "paid", payment_link: "pl_old" } },
    });

    mockTokenValue = link.token;

    const old = Math.floor(Date.now() / 1000) - 1000;
    const res = await post(payload, sign(payload, WEBHOOK_SECRET, old));
    assert.equal(res.status, 400);

    const row = (await query("SELECT status FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "active");
  });

  test("secret mancante → 503", async () => {
    const link = await createLink(site.id, { status: "active", stripe_url: "https://buy.stripe.com/test_503" });
    const payload = JSON.stringify({
      id: "evt_5",
      type: "checkout.session.completed",
      data: { object: { payment_status: "paid", payment_link: "pl_503" } },
    });

    mockTokenValue = link.token;

    config.stripeWebhookSecret = "";
    const res = await post(payload, sign(payload));
    config.stripeWebhookSecret = WEBHOOK_SECRET;
    assert.equal(res.status, 503);

    const row = (await query("SELECT status FROM payment_links WHERE id = $1", [link.id])).rows[0];
    assert.equal(row.status, "active");
  });

  test("header Stripe-Signature mancante → 400", async () => {
    const payload = JSON.stringify({ id: "evt_6", type: "customer.created", data: { object: {} } });
    const res = await fetch(`${whBaseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 400);
  });
});
