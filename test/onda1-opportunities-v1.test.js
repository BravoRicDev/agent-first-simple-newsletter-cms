import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 1 — Opportunità sulla surface /v1 (riusa services/opportunities.js).
describe("ONDA 1 — opportunità API /v1", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;

  before(async () => {
    siteA = await createTestSite("O1 Opp Tenant A");
    siteB = await createTestSite("O1 Opp Tenant B");

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

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: err.message });
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

  const auth = (tenant, key) => ({
    "Location-Id": String(tenant),
    Authorization: `Bearer ${key}`,
    Version: "2017-04-19",
  });
  const postJson = (url, body, headers = {}) => fetch(url, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  test("401 senza credenziali", async () => {
    const res = await fetch(`${baseUrl}/v1/opportunities`, { headers: { "Location-Id": String(siteA.id) } });
    assert.equal(res.status, 401);
  });

  test("CRUD opportunità + status + isolamento", async () => {
    const createRes = await postJson(`${baseUrl}/v1/opportunities`, {
      contactEmail: "cliente@example.test", title: "Progetto Web", amount: 5000, probability: 60,
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(createRes.status, 201);
    const opp = (await createRes.json()).opportunity;
    assert.ok(Number.isInteger(opp.id));
    assert.equal(opp.title, "Progetto Web");
    assert.equal(opp.contactEmail, "cliente@example.test");
    assert.equal(opp.amount, 5000);
    assert.equal(opp.probability, 60);

    // GET singolo
    const getRes = await fetch(`${baseUrl}/v1/opportunities/${opp.id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(getRes.status, 200);
    assert.equal((await getRes.json()).opportunity.title, "Progetto Web");

    // GET lista
    const listRes = await fetch(`${baseUrl}/v1/opportunities`, { headers: auth(siteA.id, apiKeyA.raw) });
    const list = (await listRes.json()).opportunities;
    assert.ok(list.some(o => o.id === opp.id));

    // Isolamento B
    const listB = await fetch(`${baseUrl}/v1/opportunities`, { headers: auth(siteB.id, apiKeyB.raw) });
    const oppB = (await listB.json()).opportunities;
    assert.ok(!oppB.some(o => o.id === opp.id));

    // PUT update
    const putRes = await fetch(`${baseUrl}/v1/opportunities/${opp.id}`, {
      method: "PUT", headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 7000, stage: "proposta_inviata" }),
    });
    assert.equal(putRes.status, 200);
    const upd = (await putRes.json()).opportunity;
    assert.equal(upd.amount, 7000);
    assert.equal(upd.stage, "proposta_inviata");

    // PUT status → won
    const statusRes = await fetch(`${baseUrl}/v1/opportunities/${opp.id}/status`, {
      method: "PUT", headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "won" }),
    });
    assert.equal(statusRes.status, 200);
    assert.equal((await statusRes.json()).opportunity.status, "won");

    // DELETE
    const delRes = await fetch(`${baseUrl}/v1/opportunities/${opp.id}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(delRes.status, 200);
    const getDel = await fetch(`${baseUrl}/v1/opportunities/${opp.id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(getDel.status, 404);
  });

  test("search + upsert", async () => {
    await postJson(`${baseUrl}/v1/opportunities`, { contactEmail: "ups@example.test", title: "Sito Vetrina" }, auth(siteA.id, apiKeyA.raw));

    const s = await postJson(`${baseUrl}/v1/opportunities/search`, { contactEmail: "ups@example.test" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(s.status, 200);
    assert.ok((await s.json()).opportunities.some(o => o.title === "Sito Vetrina"));

    const u1 = await postJson(`${baseUrl}/v1/opportunities/upsert`, { contactEmail: "ups@example.test", title: "Sito Vetrina", amount: 900 }, auth(siteA.id, apiKeyA.raw));
    assert.equal(u1.status, 200);
    const u1json = await u1.json();
    assert.equal(u1json.created, false);
    assert.equal(u1json.opportunity.amount, 900);

    const u2 = await postJson(`${baseUrl}/v1/opportunities/upsert`, { contactEmail: "ups@example.test", title: "Logo Pack" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(u2.status, 201);
    assert.equal((await u2.json()).created, true);
  });

  test("followers + validazione status", async () => {
    const r = await postJson(`${baseUrl}/v1/opportunities`, { contactEmail: "f@example.test", title: "X" }, auth(siteA.id, apiKeyA.raw));
    const oid = (await r.json()).opportunity.id;

    const f = await fetch(`${baseUrl}/v1/opportunities/${oid}/followers`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(f.status, 200);
    assert.deepEqual((await f.json()).followers, []);

    const bad = await fetch(`${baseUrl}/v1/opportunities/${oid}/status`, {
      method: "PUT", headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "nonsense" }),
    });
    assert.equal(bad.status, 400);
  });
});
