import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

describe("ONDA 3 — v1 activities HTTP routes", () => {
  let server, baseUrl, siteA, apiKeyA;
  const email = uniqueEmail("hvact");

  before(async () => {
    siteA = await createTestSite("DVH Activities A");
    const crypto = (await import("crypto")).default;
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key", crypto.createHash("sha256").update(raw).digest("hex"), raw.slice(0, 12)]
    );
    apiKeyA = raw;

    await query(
      `INSERT INTO contact_events (site_id, email, event_type, payload)
       VALUES ($1, $2, 'contact_created', '{}')`,
      [siteA.id, email]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    await query(`DELETE FROM contact_events WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM site_api_keys WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM sites WHERE id = $1`, [siteA.id]);
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.siteId !== undefined) headers["Location-Id"] = String(opts.siteId);
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    const url = `${baseUrl}/v1${path}`;
    const res = await fetch(url, { method: opts.method || "GET", headers });
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body };
  }

  test("GET /v1/activities → 200 con attività", async () => {
    const r = await api("/activities", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.activities));
    assert.equal(r.body.total, 1);
    assert.equal(r.body.activities[0].event_type, "contact_created");
    assert.equal(r.body.activities[0].email, email);
  });

  test("GET /v1/activities → 401 senza auth", async () => {
    const r = await api("/activities", { siteId: siteA.id, token: "" });
    assert.equal(r.status, 401);
  });

  test("GET /v1/activities?email=... filtra per email", async () => {
    const r = await api(`/activities?email=${encodeURIComponent(email)}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    const empty = await api("/activities?email=nessuno@test.com", { siteId: siteA.id, token: apiKeyA });
    assert.equal(empty.body.total, 0);
  });
});
