import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// RIFINITURA v1 — custom field per-tenant mappati sulle OPPORTUNITÀ.
// Un'opportunità espone `customFields: { field_key: value }` nel payload /v1
// (object_key='opportunity'), validati contro la definizione in `custom_fields`
// (field_key sconosciuti ignorati) e rispettosi dell'isolamento tenant.
describe("RIFINITURA — opportunità con custom fields (/v1)", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;

  before(async () => {
    siteA = await createTestSite("RF Opp CF Tenant A");
    siteB = await createTestSite("RF Opp CF Tenant B");

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
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = (tenant, key) => ({ "Location-Id": String(tenant), Authorization: `Bearer ${key}`, Version: "2017-04-19" });
  const postJson = (url, body, headers = {}) => fetch(url, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  // Define custom fields for object_key='opportunity' on tenant A.
  // Idempotente (ON CONFLICT DO NOTHING): ri-eseguibile senza errori.
  async function defineOpportunityCustomFields(siteId) {
    await query(
      `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, active)
       VALUES ($1, 'opportunity', 'deal_source', 'Sorgente', 'text', true),
              ($1, 'opportunity', 'priority', 'Priorità', 'select', true)
       ON CONFLICT (site_id, object_key, field_key) DO NOTHING`,
      [siteId]
    );
  }

  test("customFields: create → persistito + restituito nel payload", async () => {
    await defineOpportunityCustomFields(siteA.id);
    const r = await postJson(`${baseUrl}/v1/opportunities`, {
      contactEmail: "cf1@example.test", title: "Deal CF 1", amount: 1000,
      customFields: { deal_source: "Referral", priority: "alta" },
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(r.status, 201);
    const opp = (await r.json()).opportunity;
    assert.deepEqual(opp.customFields, { deal_source: "Referral", priority: "alta" });

    // GET singolo conferma i customFields.
    const g = await fetch(`${baseUrl}/v1/opportunities/${opp.id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(g.status, 200);
    assert.deepEqual((await g.json()).opportunity.customFields, { deal_source: "Referral", priority: "alta" });
  });

  test("customFields: field_key non definito ignorato (warn)", async () => {
    const r = await postJson(`${baseUrl}/v1/opportunities`, {
      contactEmail: "cf2@example.test", title: "Deal CF 2",
      customFields: { deal_source: "Web", ghost_key: "xxx" },
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(r.status, 201);
    const opp = (await r.json()).opportunity;
    assert.deepEqual(opp.customFields, { deal_source: "Web" });
  });

  test("customFields: update fa merge (aggiunge/cambia, mantiene gli altri)", async () => {
    const r = await postJson(`${baseUrl}/v1/opportunities`, {
      contactEmail: "cf3@example.test", title: "Deal CF 3",
      customFields: { deal_source: "Inbound" },
    }, auth(siteA.id, apiKeyA.raw));
    const oid = (await r.json()).opportunity.id;

    const u = await fetch(`${baseUrl}/v1/opportunities/${oid}`, {
      method: "PUT", headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ customFields: { priority: "media" } }),
    });
    assert.equal(u.status, 200);
    const upd = (await u.json()).opportunity;
    assert.deepEqual(upd.customFields, { deal_source: "Inbound", priority: "media" });
  });

  test("customFields: isolamento tenant — B non vede i valori di A", async () => {
    const r = await postJson(`${baseUrl}/v1/opportunities`, {
      contactEmail: "cfB@example.test", title: "Deal B",
      customFields: { deal_source: "Solo B" },
    }, auth(siteB.id, apiKeyB.raw));
    assert.equal(r.status, 201);
    const oppB = (await r.json()).opportunity;
    assert.deepEqual(oppB.customFields, {}, "B non ha custom fields definiti → nessun valore");

    // Anche se B definisse lo stesso field_key, i valori restano per-tenant.
    await query(
      `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, active)
       VALUES ($1, 'opportunity', 'deal_source', 'Sorgente', 'text', true)`,
      [siteB.id]
    );
    const r2 = await postJson(`${baseUrl}/v1/opportunities`, {
      contactEmail: "cfB2@example.test", title: "Deal B2",
      customFields: { deal_source: "Solo B2" },
    }, auth(siteB.id, apiKeyB.raw));
    assert.equal(r2.status, 201);
    assert.deepEqual((await r2.json()).opportunity.customFields, { deal_source: "Solo B2" });

    // Lista opportunità di A: i customFields di A restano intatti.
    const listA = await fetch(`${baseUrl}/v1/opportunities`, { headers: auth(siteA.id, apiKeyA.raw) });
    const oppA = (await listA.json()).opportunities.find((o) => o.title === "Deal CF 1");
    assert.deepEqual(oppA.customFields, { deal_source: "Referral", priority: "alta" });
  });

  test("customFields: delete rimuove anche i custom values", async () => {
    const r = await postJson(`${baseUrl}/v1/opportunities`, {
      contactEmail: "cf4@example.test", title: "Deal CF 4",
      customFields: { deal_source: "X" },
    }, auth(siteA.id, apiKeyA.raw));
    const oid = (await r.json()).opportunity.id;

    const del = await fetch(`${baseUrl}/v1/opportunities/${oid}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(del.status, 200);

    const row = (await query(
      "SELECT 1 FROM contact_custom_values WHERE site_id = $1 AND contact_id = $2 AND object_key = 'opportunity'",
      [siteA.id, oid]
    )).rows;
    assert.equal(row.length, 0, "custom values dell'opportunità eliminati con l'opportunità");
  });
});
