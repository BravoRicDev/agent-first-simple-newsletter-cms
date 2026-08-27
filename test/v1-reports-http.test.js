import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

describe("ONDA 3 — v1 reports HTTP routes", () => {
  let server, baseUrl, siteA, apiKeyA, configId;

  before(async () => {
    siteA = await createTestSite("DVH Reports A");
    const crypto = (await import("crypto")).default;
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key", crypto.createHash("sha256").update(raw).digest("hex"), raw.slice(0, 12)]
    );
    apiKeyA = raw;

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
    await query(`DELETE FROM report_configs WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM report_runs WHERE site_id = $1`, [siteA.id]);
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
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method: opts.method || "GET",
      headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body };
  }

  test("POST /v1/reports crea config → 201", async () => {
    const r = await api("/reports", {
      method: "POST", siteId: siteA.id, token: apiKeyA,
      body: { name: "HTTP Report", kind: "weekly", sections: ["leads", "pipeline"] },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.report.id);
    assert.equal(r.body.report.name, "HTTP Report");
    configId = r.body.report.id;
  });

  test("GET /v1/reports → lista config", async () => {
    const r = await api("/reports", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.reports));
    assert.ok(r.body.reports.some((x) => x.id === configId));
  });

  test("GET /v1/reports/:id → dettaglio", async () => {
    const r = await api(`/reports/${configId}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.report.id, configId);
  });

  test("PUT /v1/reports/:id aggiorna", async () => {
    const r = await api(`/reports/${configId}`, {
      method: "PUT", siteId: siteA.id, token: apiKeyA, body: { kind: "monthly" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.report.kind, "monthly");
  });

  test("POST /v1/reports/:id/run → generazione dry-run (senza invio)", async () => {
    const r = await api(`/reports/${configId}/run`, { method: "POST", siteId: siteA.id, token: apiKeyA, body: {} });
    assert.equal(r.status, 200);
    assert.ok(r.body.report.config_id);
    assert.ok(r.body.report.generated_at);
    assert.ok(r.body.report.html);
  });

  test("POST /v1/reports/999999/run → 404", async () => {
    const r = await api("/reports/999999/run", { method: "POST", siteId: siteA.id, token: apiKeyA, body: {} });
    assert.equal(r.status, 404);
  });

  test("GET /v1/reports/:id/runs → storico (vuoto)", async () => {
    const r = await api(`/reports/${configId}/runs`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.runs));
  });

  test("POST /v1/reports senza auth → 401", async () => {
    const r = await api("/reports", { method: "POST", siteId: siteA.id, token: "", body: { name: "x" } });
    assert.equal(r.status, 401);
  });

  test("DELETE /v1/reports/:id elimina", async () => {
    const r = await api(`/reports/${configId}`, { method: "DELETE", siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    const after = await api(`/reports/${configId}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(after.status, 404);
  });
});