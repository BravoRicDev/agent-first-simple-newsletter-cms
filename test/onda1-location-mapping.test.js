import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 1 — mapping Location CRM ↔ Site.
//
// Un nodo n8n può passare nell'header `Location-Id` l'UUID della location
//  per identificare il sito/tenant del CMS. Il middleware
// requireTenant deve risolverlo tramite sites.crm_location_id.
describe("ONDA1 — mapping Location CRM ↔ Site", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA;
  const ghlLocA = "ghl_loc_" + crypto.randomBytes(8).toString("hex");
  const ghlLocB = "ghl_loc_" + crypto.randomBytes(8).toString("hex");

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

  before(async () => {
    siteA = await createTestSite("CRM Tenant A");
    siteB = await createTestSite("CRM Tenant B");

    // Associa a ogni site la sua location CRM.
    await query("UPDATE sites SET crm_location_id = $1 WHERE id = $2", [ghlLocA, siteA.id]);
    await query("UPDATE sites SET crm_location_id = $1 WHERE id = $2", [ghlLocB, siteB.id]);

    apiKeyA = await mkKey(siteA.id, "key A");

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

  test("l'UUID della location CRM nell'header Location-Id risolve il site giusto", async () => {
    // GET /v1/config è un probe per-tenant: 200 conferma tenant risolto.
    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: { "Location-Id": ghlLocA, Authorization: `Bearer ${apiKeyA.raw}` },
    });
    assert.equal(res.status, 200, `atteso 200, ricevuto ${res.status}`);
  });

  test("la location CRM di un ALTRO site NON risolve (auth fallisce sul tenant sbagliato)", async () => {
    // Passo la location di B ma la key di A: la location risolve siteB, la key è di siteA → 401.
    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: { "Location-Id": ghlLocB, Authorization: `Bearer ${apiKeyA.raw}` },
    });
    assert.equal(res.status, 401, `atteso 401 (key di tenant diverso), ricevuto ${res.status}`);
  });

  test("UUID CRM inesistente → tenant non trovato (404)", async () => {
    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: { "Location-Id": "ghl_loc_inesistente", Authorization: `Bearer ${apiKeyA.raw}` },
    });
    assert.equal(res.status, 404, `atteso 404, ricevuto ${res.status}`);
  });

  test("il field crm_location_id è persistito e univoco", async () => {
    const row = (await query("SELECT crm_location_id FROM sites WHERE id = $1", [siteA.id])).rows[0];
    assert.equal(row.crm_location_id, ghlLocA);
    // Unicità: tentativo di assegnare la stessa location a un altro site → violazione unique.
    await assert.rejects(
      query("UPDATE sites SET crm_location_id = $1 WHERE id = $2", [ghlLocA, siteB.id]),
      /duplicate key|unique/i
    );
  });
});
