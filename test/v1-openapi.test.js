import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import v1Routes from "../src/routes/v1.js";
import { closeDb } from "./helpers.js";

// OpenAPI — documentazione della surface API-compatibile ("API compatibili con
// CRM diffusi"). Le route /v1/openapi.json e /v1/docs sono PUBBLICHE: montate
// PRIMA di requireTenant(), quindi NON richiedono Location-Id/Bearer.
describe("v1 — documentazione OpenAPI", () => {
  let server, baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  test("GET /v1/openapi.json → 200 JSON senza auth, spec 3.0.0 valido", async () => {
    const res = await fetch(`${baseUrl}/v1/openapi.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const spec = await res.json();
    assert.equal(spec.openapi, "3.0.0");
    assert.ok(spec.info?.title, "info.title presente");
    assert.ok(spec.paths && typeof spec.paths === "object", "paths è un oggetto");
    assert.ok(Object.keys(spec.paths).length > 0, "paths non vuoto");
  });

  test("lo spec copre le route chiave dei 6 blocchi v1 + api-keys + capabilities", async () => {
    const res = await fetch(`${baseUrl}/v1/openapi.json`);
    const spec = await res.json();
    const paths = new Set(Object.keys(spec.paths));
    const expected = [
      // custom fields
      "/custom-fields", "/custom-fields/object-key/{objectKey}", "/custom-fields/folder", "/custom-fields/{id}",
      // pipelines
      "/pipelines", "/pipelines/{id}",
      // config + mapping location
      "/config", "/location",
      // opportunità
      "/opportunities", "/opportunities/search", "/opportunities/upsert",
      "/opportunities/lost-reason", "/opportunities/pipelines", "/opportunities/{id}",
      "/opportunities/{id}/status", "/opportunities/{id}/followers",
      // contatti
      "/contacts", "/contacts/search", "/contacts/upsert", "/contacts/search/duplicate",
      "/contacts/{id}", "/contacts/{id}/notes", "/contacts/{id}/notes/{noteId}",
      "/contacts/{id}/tags", "/contacts/{id}/tags/{tag}", "/contacts/{id}/tasks",
      "/contacts/{id}/tasks/{taskId}", "/contacts/{id}/followers", "/contacts/{id}/campaigns",
      "/contacts/{id}/workflow",
      // api-keys + capabilities
      "/api-keys", "/api-keys/{id}", "/capabilities",
      // booking (ONDA 2)
      "/bookings", "/bookings/{id}",
    ];
    for (const p of expected) {
      assert.ok(paths.has(p), `route ${p} documentata nello spec`);
    }
  });

  test("lo spec documenta la security scheme Location-Id header + BearerAuth http", async () => {
    const res = await fetch(`${baseUrl}/v1/openapi.json`);
    const spec = await res.json();
    const schemes = spec.components?.securitySchemes || {};
    assert.equal(schemes.LocationId?.type, "apiKey");
    assert.equal(schemes.LocationId?.in, "header");
    assert.equal(schemes.LocationId?.name, "Location-Id");
    assert.equal(schemes.BearerAuth?.type, "http");
    assert.equal(schemes.BearerAuth?.scheme, "bearer");
    // Le operazioni API applicano la security (presenza di [LocationId, BearerAuth]).
    const customFieldGetSec = spec.paths["/custom-fields"].get?.security;
    assert.ok(Array.isArray(customFieldGetSec), "le operazioni hanno security");
  });

  test("GET /v1/docs → 200 HTML con swagger-ui", async () => {
    const res = await fetch(`${baseUrl}/v1/docs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    assert.match(html, /swagger-ui/);
    assert.match(html, /openapi\.json/);
  });

  test("openapi.json è servito anche con header auth (200 comunque)", async () => {
    const res = await fetch(`${baseUrl}/v1/openapi.json`, {
      headers: { "Location-Id": "1", Authorization: "Bearer sitekey_fake" },
    });
    assert.equal(res.status, 200);
    const spec = await res.json();
    assert.equal(spec.openapi, "3.0.0");
  });
});
