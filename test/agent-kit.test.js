import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { z } from "zod";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain } from "./ext-helpers.js";
import { agentRoute, created } from "../src/routes/agent-kit.js";

describe("agent-kit", () => {
  let site, other, user, app, domain;
  let mode = "agent";
  const state = { scopes: ["read"] };

  before(async () => {
    site = await createTestSite("KitA");
    other = await createTestSite("KitB");
    user = await createTestUser(site.id, "admin");
    domain = await addDomain(site.id);

    const r = Router();
    agentRoute(r, "get", "/api/agent/sites/:siteId/kit-ok", {}, ({ siteId }) => ({ siteId }));
    agentRoute(r, "post", "/api/agent/sites/:siteId/kit-w", { write: true }, () => created({ ok: 1 }));
    agentRoute(r, "get", "/api/agent/sites/:siteId/kit-bad", {}, () => {
      z.object({ a: z.number() }).parse({});
    });

    app = await startApp({
      before: (a) => a.use((req, res, next) => {
        req.user = mode === "agent"
          ? { agent: true, api_token: true, role: "admin", site_id: site.id, sub: 1, scopes: state.scopes }
          : { role: "admin", site_id: site.id, sub: 1 };
        next();
      }),
      routers: [r],
    });
  });

  after(async () => { app.close(); await closeDb(); });

  test("GET own site -> 200 with siteId", async () => {
    const res = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/kit-ok`, { host: domain });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { siteId: site.id });
  });

  test("GET other site -> 403", async () => {
    const res = await httpReq(app.baseUrl, `/api/agent/sites/${other.id}/kit-ok`, { host: domain });
    assert.equal(res.status, 403);
  });

  test("non-numeric id -> 400 invalid_id", async () => {
    const res = await httpReq(app.baseUrl, `/api/agent/sites/abc/kit-ok`, { host: domain });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, "invalid_id");
  });

  test("POST write without write scope -> 403 token_scope_required", async () => {
    state.scopes = ["read"];
    const res = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/kit-w`, { method: "POST", host: domain, body: {} });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, "token_scope_required");
  });

  test("POST write with write scope -> 201 {ok:1}", async () => {
    state.scopes = ["read", "write"];
    const res = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/kit-w`, { method: "POST", host: domain, body: {} });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json(), { ok: 1 });
  });

  test("ZodError -> 400 validation_failed with fields[0].path a", async () => {
    const res = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/kit-bad`, { host: domain });
    assert.equal(res.status, 400);
    const j = res.json();
    assert.equal(j.error, "validation_failed");
    assert.equal(j.fields[0].path, "a");
  });

  test("req.user without agent:true -> 403", async () => {
    mode = "session";
    const res = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/kit-ok`, { host: domain });
    mode = "agent";
    assert.equal(res.status, 403);
  });
});
