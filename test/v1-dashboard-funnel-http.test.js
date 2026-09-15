import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

describe("ONDA 3 — v1 dashboard & funnel HTTP routes", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;

  before(async () => {
    siteA = await createTestSite("DVH Tenant A");
    siteB = await createTestSite("DVH Tenant B");

    // Crea API key per-sito
    const crypto = (await import("crypto")).default;
    const mk = async (siteId, name) => {
      const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const r = await query(
        "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
        [siteId, name, hash, raw.slice(0, 12)]
      );
      return { id: r.rows[0].id, raw };
    };
    apiKeyA = await mk(siteA.id, "key A");
    apiKeyB = await mk(siteB.id, "key B");

    // Crea dati di test per siteA
    await query(
      `INSERT INTO contacts (site_id, email, status, created_at)
       VALUES ($1, 'http-lead@test.com', 'new', NOW())`,
      [siteA.id]
    );
    await query(
      `INSERT INTO opportunities (site_id, contact_email, title, amount, status)
       VALUES ($1, 'http-lead@test.com', 'HTTP Opp', 3000, 'open')`,
      [siteA.id]
    );
    await query(
      `INSERT INTO funnel_snapshots (site_id, day, channel, visits, leads, calls, wins, revenue)
       VALUES ($1, CURRENT_DATE, 'web', 80, 8, 3, 1, 300.00)
       ON CONFLICT (site_id, day, channel)
       DO UPDATE SET visits=EXCLUDED.visits, leads=EXCLUDED.leads,
                     calls=EXCLUDED.calls, wins=EXCLUDED.wins, revenue=EXCLUDED.revenue`,
      [siteA.id]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // Pulisci dati di test
    await query(`DELETE FROM site_api_keys WHERE site_id IN ($1, $2)`, [siteA.id, siteB.id]);
    await query(`DELETE FROM contacts WHERE email = 'http-lead@test.com'`);
    await query(`DELETE FROM opportunities WHERE contact_email = 'http-lead@test.com'`);
    await query(`DELETE FROM funnel_snapshots WHERE site_id = $1`, [siteA.id]);
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.siteId !== undefined) headers["Location-Id"] = String(opts.siteId);
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    if (opts.body) headers["Content-Type"] = "application/json";
    const url = `${baseUrl}/v1${path}`;
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const body = res.headers.get("content-type")?.includes("json")
      ? await res.json()
      : await res.text();
    return { status: res.status, body, headers: res.headers };
  }

  test("GET /v1/dashboard → 200 con KPIs", async () => {
    const r = await api("/dashboard", { siteId: siteA.id, token: apiKeyA.raw });
    assert.equal(r.status, 200);
    assert.ok(r.body.leads !== undefined, "dovrebbe avere leads");
    assert.ok(r.body.generated_at, "dovrebbe avere generated_at");
    assert.ok(Array.isArray(r.body.leads_by_channel), "leads_by_channel array");
  });

  test("GET /v1/dashboard?range=7d → 200 con range=7d", async () => {
    const r = await api("/dashboard?range=7d", { siteId: siteA.id, token: apiKeyA.raw });
    assert.equal(r.status, 200);
    assert.equal(r.body.range, "7d");
  });

  test("GET /v1/dashboard → 401 senza auth", async () => {
    const r = await api("/dashboard", { siteId: siteA.id, token: "" });
    assert.equal(r.status, 401);
  });

  test("GET /v1/funnel → 200 con dati funnel", async () => {
    const r = await api("/funnel", { siteId: siteA.id, token: apiKeyA.raw });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.funnel), "funnel dovrebbe essere array");
    assert.ok(r.body.funnel.length >= 1, "almeno 1 riga funnel");
    const row = r.body.funnel[0];
    assert.ok(row.day, "dovrebbe avere day");
    assert.ok(row.channel !== undefined, "dovrebbe avere channel");
    assert.equal(row.visits, 80, "visits dovrebbe essere 80");
  });

  test("GET /v1/funnel → 401 senza auth", async () => {
    const r = await api("/funnel", { siteId: siteA.id, token: "" });
    assert.equal(r.status, 401);
  });

  test("GET /v1/funnel?from=2020-01-01&to=2099-12-31 → 200 con dati", async () => {
    const r = await api("/funnel?from=2020-01-01&to=2099-12-31", {
      siteId: siteA.id,
      token: apiKeyA.raw,
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.funnel));
    assert.ok(r.body.funnel.length >= 1, "dovrebbe trovare righe nel range ampio");
  });

  test("GET /v1/funnel → 200 per siteB (nessun dato, array vuoto)", async () => {
    const r = await api("/funnel", { siteId: siteB.id, token: apiKeyB.raw });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.funnel));
    assert.equal(r.body.funnel.length, 0, "siteB senza funnel → array vuoto");
  });
});