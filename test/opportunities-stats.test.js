import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import opportunitiesStatsRoutes from "../src/routes/opportunities-stats.js";

describe("Opportunities Stats API", () => {
  let server, baseUrl;
  let site;
  let user;
  let token;
  let pipeline;

  before(async () => {
    site = await createTestSite("Opportunities Stats Test");
    user = await createTestUser(site.id, "admin");
    const apiToken = await createApiToken(user.id, "test-token", 30);
    token = apiToken.token;

    const pipelineResult = await query(
      "INSERT INTO pipelines (site_id, name, stages, is_default) VALUES ($1, $2, '[]', true) RETURNING id",
      [site.id, "Test Pipeline"]
    );
    pipeline = { id: pipelineResult.rows[0].id };

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(opportunitiesStatsRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  function authHeader() {
    return { Authorization: `Bearer ${token}` };
  }

  test("GET /search — ricerca opportunità", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/search?q=test`, { headers: authHeader() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data !== undefined);
  });

  test("GET /revenue — statistiche revenue", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/stats/revenue`, { headers: authHeader() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.byStatus !== undefined);
  });

  test("GET /conversion — funnel di conversione", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/stats/conversion?pipeline_id=${pipeline.id}`, { headers: authHeader() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.funnel !== undefined);
  });

  test("GET /vendor — statistiche vendor", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/stats/vendor`, { headers: authHeader() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.vendors !== undefined);
  });

  test("GET /trend — trend", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/stats/trend`, { headers: authHeader() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.trend !== undefined);
  });

  test("PUT /:id/owner — riassegnazione owner", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/999/owner`, {
      method: "PUT",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "test vendor" }),
    });
    assert.ok([404, 400, 409].includes(res.status));
  });
});
