import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import config from "../src/config.js";
import { createTestSite, closeDb } from "./helpers.js";
import { apiDialect } from "../src/middleware/api-dialect.js";

// Fase 0 — adattatore dual-dialect (docs/API_CLONE_MASTER_PLAN.md §4.3):
// legacy (Location-Id + Bearer sitekey_), moderno (Bearer + locationId +
// Version), nessuna credenziale → 401.
describe("Fase 0 — adattatore dual-dialect (api-dialect.js)", () => {
  let site, server, baseUrl, rawKey;

  before(async () => {
    site = await createTestSite("Dialect Test");
    rawKey = "sitekey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [site.id, "dialect test key", hash, rawKey.slice(0, 12)]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(apiDialect());
    app.use((req, res) => res.status(200).json({
      apiDialect: req.apiDialect,
      apiVersion: req.apiVersion ?? null,
      siteId: req.tenant?.siteId ?? null,
    }));
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
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

  test("dialetto legacy: Location-Id + Bearer sitekey_ → apiDialect=legacy", async () => {
    const res = await fetch(`${baseUrl}/whatever`, {
      headers: { "Location-Id": String(site.id), Authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.apiDialect, "legacy");
    assert.equal(body.siteId, site.id);
  });

  test("dialetto legacy: credenziali sbagliate → propaga l'errore di tenant-api.js (401)", async () => {
    const res = await fetch(`${baseUrl}/whatever`, {
      headers: { "Location-Id": String(site.id), Authorization: "Bearer chiave_sbagliata" },
    });
    assert.equal(res.status, 401);
  });

  test("dialetto moderno: Bearer + locationId (query) + Version supportata → apiDialect=modern", async () => {
    const version = config.supportedApiVersions[0];
    const res = await fetch(`${baseUrl}/whatever?locationId=${site.id}`, {
      headers: { Authorization: `Bearer ${rawKey}`, Version: version },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.apiDialect, "modern");
    assert.equal(body.apiVersion, version);
    assert.equal(body.siteId, site.id);
  });

  test("dialetto moderno senza header Version → default all'ultima versione supportata", async () => {
    const res = await fetch(`${baseUrl}/whatever?locationId=${site.id}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.apiDialect, "modern");
    assert.equal(body.apiVersion, config.supportedApiVersions[config.supportedApiVersions.length - 1]);
  });

  test("dialetto moderno con Version non supportata → 400", async () => {
    const res = await fetch(`${baseUrl}/whatever?locationId=${site.id}`, {
      headers: { Authorization: `Bearer ${rawKey}`, Version: "1999-01-01" },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { statusCode: 400, message: "Bad Request" });
  });

  test("nessuna credenziale valida → 401", async () => {
    const res = await fetch(`${baseUrl}/whatever`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { statusCode: 401, message: "Non autenticato" });
  });

  test("Bearer valido ma locationId di un sito inesistente → 401", async () => {
    const res = await fetch(`${baseUrl}/whatever?locationId=999999999`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.status, 401);
  });
});
