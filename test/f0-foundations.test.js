import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";
import { listCapabilities, roleHasCapability } from "../src/services/capabilities.js";

// F0 — Fondamenta: tenancy/auth Bearer + Version ignorato + custom fields +
// pipeline/stage + config per-tenant + capability registry, su surface /v1.
describe("F0 — fondamenta multi-tenant API-compatibile", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;

  before(async () => {
    siteA = await createTestSite("F0 Tenant A");
    siteB = await createTestSite("F0 Tenant B");

    // Crea API key per-sito direttamente (hash SHA-256) per testare l'auth.
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

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
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
    // Header Version: va IGNORATO: senza questa richiesta deve comunque riuscire.
    Version: "2017-04-19",
  });

  test("401 senza header Location-Id", async () => {
    const res = await fetch(`${baseUrl}/v1/custom-fields`, {
      headers: { Authorization: `Bearer ${apiKeyA.raw}` },
    });
    assert.equal(res.status, 401);
  });

  test("401 con API key sbagliata", async () => {
    const res = await fetch(`${baseUrl}/v1/custom-fields`, {
      headers: { "Location-Id": String(siteA.id), Authorization: "Bearer chiave_sbagliata" },
    });
    assert.equal(res.status, 401);
  });

  test("custom field: id stabile + isolamento tra tenant (Version ignorato)", async () => {
    // Crea su tenant A
    const createRes = await fetch(`${baseUrl}/v1/custom-fields`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ object_key: "contact", field_key: "citta", name: "Città", type: "text" }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()).customField;
    assert.equal(created.field_key, "citta");
    assert.ok(Number.isInteger(created.id));

    // Lista su A (con Version header presente → deve riuscire comunque)
    const listRes = await fetch(`${baseUrl}/v1/custom-fields`, {
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(listRes.status, 200);
    const listA = (await listRes.json()).customFields;
    assert.ok(listA.some(f => f.field_key === "citta"));

    // Liste su B: vuoto (isolamento)
    const listB = await fetch(`${baseUrl}/v1/custom-fields`, {
      headers: { ...auth(siteB.id, apiKeyB.raw) },
    });
    const fieldsB = (await listB.json()).customFields;
    assert.ok(!fieldsB.some(f => f.field_key === "citta"));

    // object-key filter
    const objRes = await fetch(`${baseUrl}/v1/custom-fields/object-key/contact`, {
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(objRes.status, 200);

    // GET singolo, PUT, DELETE
    const getRes = await fetch(`${baseUrl}/v1/custom-fields/${created.id}`, {
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(getRes.status, 200);

    const putRes = await fetch(`${baseUrl}/v1/custom-fields/${created.id}`, {
      method: "PUT",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Città di residenza" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal((await putRes.json()).customField.name, "Città di residenza");

    const delRes = await fetch(`${baseUrl}/v1/custom-fields/${created.id}`, {
      method: "DELETE",
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(delRes.status, 200);
  });

  test("pipeline+stages: id stabile, CRUD, isolamento", async () => {
    const createRes = await fetch(`${baseUrl}/v1/pipelines`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pipeline Vendite",
        stages: [
          { key: "lead", label: "Lead" },
          { key: "proposta_inviata", label: "Proposta inviata", color: "#3366cc" },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const pipeline = (await createRes.json()).pipeline;
    assert.ok(Number.isInteger(pipeline.id));
    assert.equal(pipeline.stages.length, 2);

    // Gli stadi hanno id stabili su pipeline_stages (per-key)
    const stagesRows = (await query(
      "SELECT id, key, label FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position",
      [pipeline.id]
    )).rows;
    assert.equal(stagesRows.length, 2);
    assert.equal(stagesRows[0].key, "lead");

    // GET singola
    const getRes = await fetch(`${baseUrl}/v1/pipelines/${pipeline.id}`, {
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(getRes.status, 200);
    assert.equal((await getRes.json()).pipeline.name, "Pipeline Vendite");

    // Isolamento: tenant B non vede la pipeline di A
    const listB = await fetch(`${baseUrl}/v1/pipelines`, {
      headers: { ...auth(siteB.id, apiKeyB.raw) },
    });
    const plB = (await listB.json()).pipelines;
    assert.ok(!plB.some(p => p.id === pipeline.id));

    // PUT aggiorna stage
    const putRes = await fetch(`${baseUrl}/v1/pipelines/${pipeline.id}`, {
      method: "PUT",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Pipeline Vendite 2", stages: [{ key: "lead", label: "Lead" }, { key: "vinto", label: "Vinto" }] }),
    });
    assert.equal(putRes.status, 200);

    // DELETE
    const delRes = await fetch(`${baseUrl}/v1/pipelines/${pipeline.id}`, {
      method: "DELETE",
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(delRes.status, 200);
  });

  test("config per-tenant: set/get isolato", async () => {
    const putRes = await fetch(`${baseUrl}/v1/config`, {
      method: "PUT",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ config: { google_calendar: { client_id: "x" }, theme: "dark" } }),
    });
    assert.equal(putRes.status, 200);

    const getA = await fetch(`${baseUrl}/v1/config`, { headers: { ...auth(siteA.id, apiKeyA.raw) } });
    const cfgA = (await getA.json()).config;
    assert.equal(cfgA.theme, "dark");
    assert.equal(cfgA.google_calendar.client_id, "x");

    // Isolamento: B non vede la config di A
    const getB = await fetch(`${baseUrl}/v1/config`, { headers: { ...auth(siteB.id, apiKeyB.raw) } });
    const cfgB = (await getB.json()).config;
    assert.equal(cfgB.theme, undefined);
  });

  test("capability registry", async () => {
    const caps = await listCapabilities();
    const keys = caps.map(c => c.key);
    assert.ok(keys.includes("contacts.read"));
    assert.ok(keys.includes("opportunities.write"));
    assert.ok(keys.includes("webhooks.out"));

    const res = await fetch(`${baseUrl}/v1/capabilities`, { headers: { ...auth(siteA.id, apiKeyA.raw) } });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).capabilities));
  });

  test("API key per-sito: generazione + auth + revoca", async () => {
    const createRes = await fetch(`${baseUrl}/v1/api-keys`, {
      method: "POST",
      headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nuova chiave" }),
    });
    assert.equal(createRes.status, 201);
    const body = (await createRes.json()).apiKey;
    assert.ok(body.token, "il token in chiaro è restituito una sola volta");
    assert.ok(body.token.length > 20);

    // La nuova chiave autentica correttamente
    const okRes = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { "Location-Id": String(siteA.id), Authorization: `Bearer ${body.token}` },
    });
    assert.equal(okRes.status, 200);

    // Il DB salva hash, mai token in chiaro
    const stored = (await query("SELECT token_hash, token_prefix FROM site_api_keys WHERE id = $1", [body.id])).rows[0];
    assert.notEqual(stored.token_hash, body.token);
    assert.equal(stored.token_hash.length, 64);

    // list
    const listRes = await fetch(`${baseUrl}/v1/api-keys`, { headers: { ...auth(siteA.id, apiKeyA.raw) } });
    const keys = (await listRes.json()).apiKeys;
    assert.ok(keys.some(k => k.id === body.id));

    // delete → la chiave non autentica più
    const delRes = await fetch(`${baseUrl}/v1/api-keys/${body.id}`, {
      method: "DELETE",
      headers: { ...auth(siteA.id, apiKeyA.raw) },
    });
    assert.equal(delRes.status, 200);
    const afterDel = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { "Location-Id": String(siteA.id), Authorization: `Bearer ${body.token}` },
    });
    assert.equal(afterDel.status, 401);
  });

  test("opportunities compat: lost-reason + pipelines alias", async () => {
    const lr = await fetch(`${baseUrl}/v1/opportunities/lost-reason`, { headers: { ...auth(siteA.id, apiKeyA.raw) } });
    assert.equal(lr.status, 200);
    assert.ok(Array.isArray((await lr.json()).lostReasons));

    const pp = await fetch(`${baseUrl}/v1/opportunities/pipelines`, { headers: { ...auth(siteA.id, apiKeyA.raw) } });
    assert.equal(pp.status, 200);
  });

  test("roleHasCapability riusa roles_permissions", async () => {
    // 'admin' ha resource 'sites' with can_read → admin può leggere (es. contacts.read mappato su resource contacts non c'è, quindi false)
    const adminCanReadSites = await roleHasCapability("admin", "sites.read");
    assert.equal(adminCanReadSites, true);
    // resource non esistente per admin → false
    const adminCanReadX = await roleHasCapability("admin", "doesnotexist.read");
    assert.equal(adminCanReadX, false);
  });
});
