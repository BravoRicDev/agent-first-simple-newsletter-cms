import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 1/F0 — mapping Location ↔ Site.
//
// Un nodo esterno (es. n8n) può passare nell'header `Location-Id`
// l'identificativo esterno della location per identificare il sito/tenant del
// CMS. Il middleware requireTenant lo risolve tramite `sites.location_external_id`
// (naming generico, "API compatibili con CRM diffusi").
describe("F0 — mapping Location ↔ Site (location_external_id)", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;
  const extLocA = "ext_" + crypto.randomBytes(8).toString("hex");
  const extLocB = "ext_" + crypto.randomBytes(8).toString("hex");

  // Crea un API key per un sito (hash SHA-256, mai in chiaro).
  async function mkKey(siteId, name) {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  }

  function req(path, { loc, token, method = "GET", body } = {}) {
    const headers = {
      "Location-Id": loc,
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  before(async () => {
    siteA = await createTestSite("Ext Tenant A");
    siteB = await createTestSite("Ext Tenant B");

    // Associa a ogni site la sua location esterna.
    await query("UPDATE sites SET location_external_id = $1 WHERE id = $2", [extLocA, siteA.id]);
    await query("UPDATE sites SET location_external_id = $1 WHERE id = $2", [extLocB, siteB.id]);

    apiKeyA = await mkKey(siteA.id, "key A");
    apiKeyB = await mkKey(siteB.id, "key B");

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

  test("l'identificativo esterno location nell'header Location-Id risolve il site giusto", async () => {
    // GET /v1/config è un probe per-tenant: 200 conferma tenant risolto.
    const res = await req("/config", { loc: extLocA, token: apiKeyA.raw });
    assert.equal(res.status, 200, `atteso 200, ricevuto ${res.status}`);
  });

  test("il mapping di un ALTRO site NON risolve (auth fallisce sul tenant sbagliato)", async () => {
    // Passo la location di B ma la key di A: la location risolve siteB, la key è di siteA → 401.
    const res = await req("/config", { loc: extLocB, token: apiKeyA.raw });
    assert.equal(res.status, 401, `atteso 401 (key di tenant diverso), ricevuto ${res.status}`);
  });

  test("identificativo esterno inesistente → tenant non trovato (404)", async () => {
    const res = await req("/config", { loc: "ext_inesistente", token: apiKeyA.raw });
    assert.equal(res.status, 404, `atteso 404, ricevuto ${res.status}`);
  });

  test("GET /v1/location espone il mapping verso i consumer (n8n)", async () => {
    const res = await req("/location", { loc: extLocA, token: apiKeyA.raw });
    assert.equal(res.status, 200);
    const { location } = await res.json();
    assert.equal(location.siteId, siteA.id);
    assert.equal(location.externalId, extLocA);
  });

  test("PUT /v1/location aggiorna il mapping e diventa risolvibile via Location-Id", async () => {
    const newId = "ext_" + crypto.randomBytes(8).toString("hex");
    // Aggiorna il mapping di siteA via la sua key attuale (identificato da extLocA).
    const up = await req("/location", { loc: extLocA, token: apiKeyA.raw, method: "PUT", body: { externalId: newId } });
    assert.equal(up.status, 200, `atteso 200, ricevuto ${up.status}`);
    const { location } = await up.json();
    assert.equal(location.externalId, newId);

    // Ora il nuovo id risolve il tenant (probe config con la key di A).
    const probe = await req("/config", { loc: newId, token: apiKeyA.raw });
    assert.equal(probe.status, 200, `atteso 200 dopo update, ricevuto ${probe.status}`);

    // Rimetti il valore originale per non sporcare i test successivi.
    await query("UPDATE sites SET location_external_id = $1 WHERE id = $2", [extLocA, siteA.id]);
  });

  test("PUT /v1/location con externalId già usato da altro tenant → 409", async () => {
    // Provo ad assegnare a siteB (via key B, Location-Id extLocB) l'id di siteA → viola unique.
    const res = await req("/location", { loc: extLocB, token: apiKeyB.raw, method: "PUT", body: { externalId: extLocA } });
    assert.equal(res.status, 409, `atteso 409, ricevuto ${res.status}`);
  });

  test("PUT /v1/location senza externalId → 400", async () => {
    const res = await req("/location", { loc: extLocA, token: apiKeyA.raw, method: "PUT", body: {} });
    assert.equal(res.status, 400, `atteso 400, ricevuto ${res.status}`);
  });

  test("DELETE /v1/location azzera il mapping (e la risoluzione via Location-Id poi fallisce)", async () => {
    const del = await req("/location", { loc: extLocA, token: apiKeyA.raw, method: "DELETE" });
    assert.equal(del.status, 200);
    const { location } = await del.json();
    assert.equal(location.externalId, null);

    // Dopo DELETE, Location-Id con quell'id non risolve più → 404.
    const probe = await req("/config", { loc: extLocA, token: apiKeyA.raw });
    assert.equal(probe.status, 404, `atteso 404 dopo delete, ricevuto ${probe.status}`);

    // Ripristina il mapping originale.
    await query("UPDATE sites SET location_external_id = $1 WHERE id = $2", [extLocA, siteA.id]);
  });

  test("il field location_external_id è persistito e univoco", async () => {
    const row = (await query("SELECT location_external_id FROM sites WHERE id = $1", [siteA.id])).rows[0];
    assert.equal(row.location_external_id, extLocA);
    // Unicità: tentativo di assegnare la stessa location esterna a un altro site → violazione unique.
    await assert.rejects(
      query("UPDATE sites SET location_external_id = $1 WHERE id = $2", [extLocA, siteB.id]),
      /duplicate key|unique/i
    );
  });
});
