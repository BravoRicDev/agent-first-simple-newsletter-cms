import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import v1Routes from "../src/routes/v1.js";
import { createTestSite, closeDb } from "./helpers.js";
import crypto from "crypto";

function sha256(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}

describe("v1 — payment-links API", () => {
  let server, baseUrl, site, apiKey;

  before(async () => {
    site = await createTestSite("Payment Test");
    const raw = "sitekey_" + crypto.randomBytes(32).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [site.id, "v1 payments test", sha256(raw), raw.slice(0, 16)]
    );
    apiKey = raw;

    const app = express();
    app.use(express.json());
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  function auth(extra = {}) {
    return { "Location-Id": String(site.id), Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra };
  }

  test("POST /v1/payment-links → 201 con paymentLink", async () => {
    const res = await fetch(`${baseUrl}/v1/payment-links`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({ title: "Test Payment", amount: 100.5, contact_email: "cliente@test.test" }),
    });
    assert.equal(res.status, 201);
    const { paymentLink } = await res.json();
    assert.ok(paymentLink.id);
    assert.equal(paymentLink.title, "Test Payment");
    assert.equal(paymentLink.amount, 100.5);
    assert.equal(paymentLink.status, "draft");
    assert.equal(paymentLink.contact_email, "cliente@test.test");
    assert.ok(paymentLink.token);
  });

  test("GET /v1/payment-links → 200 con array", async () => {
    const res = await fetch(`${baseUrl}/v1/payment-links`, { headers: auth() });
    assert.equal(res.status, 200);
    const { paymentLinks, total } = await res.json();
    assert.ok(Array.isArray(paymentLinks));
    assert.equal(typeof total, "number");
    assert.ok(paymentLinks.length > 0);
    assert.ok(paymentLinks.every((p) => typeof p.amount === "number"));
  });

  let linkId;

  test("GET /v1/payment-links/:id → 200 e 404", async () => {
    const createRes = await fetch(`${baseUrl}/v1/payment-links`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({ title: "Specific Link", amount: 50 }),
    });
    const { paymentLink } = await createRes.json();
    linkId = paymentLink.id;

    const res = await fetch(`${baseUrl}/v1/payment-links/${linkId}`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.paymentLink.id, linkId);

    const res404 = await fetch(`${baseUrl}/v1/payment-links/99999`, { headers: auth() });
    assert.equal(res404.status, 404);
  });

  test("PUT /v1/payment-links/:id → 200", async () => {
    const res = await fetch(`${baseUrl}/v1/payment-links/${linkId}`, {
      method: "PUT", headers: auth(),
      body: JSON.stringify({ title: "Updated Link", amount: 75 }),
    });
    assert.equal(res.status, 200);
    const { paymentLink } = await res.json();
    assert.equal(paymentLink.title, "Updated Link");
    assert.equal(paymentLink.amount, 75);
  });

  test("POST /v1/payment-links/:id/mark-paid → 200 con already:false", async () => {
    const res = await fetch(`${baseUrl}/v1/payment-links/${linkId}/mark-paid`, {
      method: "POST", headers: auth(),
    });
    assert.equal(res.status, 200);
    const { paymentLink, already } = await res.json();
    assert.equal(paymentLink.status, "paid");
    assert.ok(paymentLink.paid_at);
    assert.equal(already, false);
  });

  test("mark-paid due volte → already:true", async () => {
    const res = await fetch(`${baseUrl}/v1/payment-links/${linkId}/mark-paid`, {
      method: "POST", headers: auth(),
    });
    assert.equal(res.status, 200);
    const { already } = await res.json();
    assert.equal(already, true);
  });

  test("DELETE /v1/payment-links/:id → 200", async () => {
    const res = await fetch(`${baseUrl}/v1/payment-links/${linkId}`, {
      method: "DELETE", headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);

    const getRes = await fetch(`${baseUrl}/v1/payment-links/${linkId}`, { headers: auth() });
    assert.equal(getRes.status, 404);
  });

  test("401 senza credenziali", async () => {
    const res = await fetch(`${baseUrl}/v1/payment-links`);
    assert.equal(res.status, 401);
  });

  test("Isolamento tenant", async () => {
    const site2 = await createTestSite("Payment Test 2");
    const raw2 = "sitekey_" + crypto.randomBytes(32).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [site2.id, "v1 payments test 2", sha256(raw2), raw2.slice(0, 16)]
    );

    const createRes = await fetch(`${baseUrl}/v1/payment-links`, {
      method: "POST",
      headers: { "Location-Id": String(site2.id), Authorization: `Bearer ${raw2}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Site2 Payment", amount: 200 }),
    });
    assert.equal(createRes.status, 201);
    const { paymentLink } = await createRes.json();

    // site1 should NOT see site2's link
    const getRes = await fetch(`${baseUrl}/v1/payment-links/${paymentLink.id}`, {
      headers: auth({ "Content-Type": undefined }),
    });
    assert.equal(getRes.status, 404);

    // site2 should see it
    const getRes2 = await fetch(`${baseUrl}/v1/payment-links/${paymentLink.id}`, {
      headers: { "Location-Id": String(site2.id), Authorization: `Bearer ${raw2}` },
    });
    assert.equal(getRes2.status, 200);
  });
});