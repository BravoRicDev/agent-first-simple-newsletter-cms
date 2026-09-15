import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import salesApiRoutes from "../src/routes/sales-api.js";
import authRouter from "../src/routes/auth.js";

// Gate globale scope write (middleware/auth.js): un agtok_ read-only non può
// eseguire POST/PUT/PATCH/DELETE su nessuna surface /api/*, salvo l'allowlist
// dei POST-di-lettura e le esclusioni /api/auth/* e /api/mcp. Copre anche gli
// endpoint futuri: il gate sta in requireAuth, non nelle singole rotte.
describe("gate scope token: sola lettura davvero ovunque", () => {
  let siteA, siteB, roToken, rwToken, capToken, closerCapToken, server, baseUrl;

  before(async () => {
    siteA = await createTestSite("Gate A");
    siteB = await createTestSite("Gate B");
    const superadmin = await createTestUser(siteA.id, "superadmin");
    const closer = await createTestUser(siteA.id, "closer");

    roToken = (await createApiToken(superadmin.id, "ro", 30, ["read"])).token;
    rwToken = (await createApiToken(superadmin.id, "rw", 30, ["read", "write"])).token;
    // Superadmin con tetto collaboratore: perde superpoteri sul token.
    capToken = (await createApiToken(superadmin.id, "capped", 30, ["read", "write"], "collaboratore")).token;
    // Il tetto NON eleva: un closer con cap admin resta closer.
    closerCapToken = (await createApiToken(closer.id, "closer capped", 30, ["read", "write"], "admin")).token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use(salesApiRoutes);
    app.use(authRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });
  const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  test("token read-only: POST pagina → 403 token_scope_required", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${siteA.id}/pages`, {
      method: "POST",
      headers: auth(roToken),
      body: JSON.stringify({ url_path: "/gate", title: "x" }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "token_scope_required");
  });

  test("token read+write: stessa chiamata → successo", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${siteA.id}/pages`, {
      method: "POST",
      headers: auth(rwToken),
      body: JSON.stringify({ url_path: "/gate", title: "creata dal gate test" }),
    });
    assert.equal(res.status, 201);
  });

  test("token read-only: GET resta libero", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${siteA.id}/pages`, { headers: auth(roToken) });
    assert.equal(res.status, 200);
  });

  test("allowlist POST-di-lettura: pages/search passa col token read-only", async () => {
    const res = await fetch(`${baseUrl}/api/agent/pages/search?q=gate`, {
      method: "POST",
      headers: auth(roToken),
      body: JSON.stringify({ q: "gate", site_id: siteA.id }),
    });
    assert.notEqual(res.status, 403);
  });

  test("allowlist: call-verdict risponde col suo contratto (non 403)", async () => {
    const res = await fetch(`${baseUrl}/api/call-verdict`, {
      method: "POST",
      headers: auth(roToken),
      body: JSON.stringify({}),
    });
    assert.notEqual(res.status, 403);
    assert.equal((await res.json()).error, "cms_opportunity_id is required");
  });

  test("POST sembranti letture ma mutanti restano bloccati (test-send)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${siteA.id}/newsletter/campaigns/1/test-send`, {
      method: "POST",
      headers: auth(roToken),
      body: JSON.stringify({ email: "x@example.test" }),
    });
    assert.equal(res.status, 403);
  });

  test("esclusione /api/mcp: il POST del transport non è bloccato dal gate", async () => {
    const res = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: auth(roToken),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.notEqual(res.status, 403);
  });

  test("esclusione /api/auth: logout raggiungibile", async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: auth(roToken) });
    assert.equal(res.status, 200);
  });

  test("tetto ruolo: superadmin capped perde endpoint superadmin", async () => {
    const uncapped = await fetch(`${baseUrl}/api/agent/satellites`, { headers: auth(rwToken) });
    assert.equal(uncapped.status, 200);

    const capped = await fetch(`${baseUrl}/api/agent/satellites`, { headers: auth(capToken) });
    assert.equal(capped.status, 403);
  });

  test("tetto ruolo: canAccessSite si restringe ai soli siti assegnati", async () => {
    const uncapped = await fetch(`${baseUrl}/api/agent/sites/${siteB.id}/pages`, { headers: auth(rwToken) });
    assert.equal(uncapped.status, 200);

    const capped = await fetch(`${baseUrl}/api/agent/sites/${siteB.id}/pages`, { headers: auth(capToken) });
    assert.equal(capped.status, 403);

    const own = await fetch(`${baseUrl}/api/agent/sites/${siteA.id}/pages`, { headers: auth(capToken) });
    assert.equal(own.status, 200);
  });

  test("il tetto non eleva: closer + cap=admin resta closer", async () => {
    const sat = await fetch(`${baseUrl}/api/agent/satellites`, { headers: auth(closerCapToken) });
    assert.equal(sat.status, 403);

    const other = await fetch(`${baseUrl}/api/agent/sites/${siteB.id}/pages`, { headers: auth(closerCapToken) });
    assert.equal(other.status, 403);
  });

  test("write API satellite: doppio livello di guardia resta coerente", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`, {
      method: "POST",
      headers: auth(roToken),
      body: JSON.stringify({ title: "x", email: "g@example.test" }),
    });
    assert.equal(res.status, 403);
  });
});
