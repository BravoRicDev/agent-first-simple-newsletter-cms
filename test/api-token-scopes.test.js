import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken, verifyApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireTokenWrite } from "../src/middleware/scopes.js";

describe("scope read/write sui token API", () => {
  let site, user, server, baseUrl;

  before(async () => {
    site = await createTestSite("Token Scopes Test");
    user = await createTestUser(site.id, "admin");

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.get("/api/whoami", requireAuth, (req, res) => res.json({ user: req.user }));
    app.post("/api/write-only", requireAuth, requireTokenWrite, (req, res) => res.json({ ok: true }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });

  test("token nuovo di default è sola lettura (scrittura opt-in)", async () => {
    const created = await createApiToken(user.id, "readonly default", 30);
    const verified = await verifyApiToken(created.token);
    assert.deepEqual(verified.scopes, ["read"]);
  });

  test("token con scrittura esplicita ha entrambi gli scope", async () => {
    const created = await createApiToken(user.id, "rw", 30, ["read", "write"]);
    const verified = await verifyApiToken(created.token);
    assert.deepEqual(verified.scopes.sort(), ["read", "write"]);
  });

  test("normalizeScopes ignora valori sconosciuti e duplicati", async () => {
    const created = await createApiToken(user.id, "dirty scopes", 30, ["write", "WRITE", "admin", "read"]);
    const verified = await verifyApiToken(created.token);
    assert.deepEqual(verified.scopes.sort(), ["read", "write"]);
  });

  test("endpoint di scrittura: 200 con scope write, 403 con token read-only", async () => {
    const ro = (await createApiToken(user.id, "ro http", 30)).token;
    const rw = (await createApiToken(user.id, "rw http", 30, ["read", "write"])).token;

    const forbidden = await fetch(`${baseUrl}/api/write-only`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ro}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error, "token_scope_required");

    const allowed = await fetch(`${baseUrl}/api/write-only`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rw}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(allowed.status, 200);
  });

  test("requireTokenWrite non filtra le sessioni interattive (no api_token)", async () => {
    // Simula una sessione browser/JWT: req.user senza api_token → passa.
    const req = { user: { sub: user.id, role: "admin" } };
    const res = { status: () => ({ json: () => { throw new Error("non deve entrare"); } }) };
    let passed = false;
    requireTokenWrite(req, res, () => { passed = true; });
    assert.ok(passed);
  });
});
