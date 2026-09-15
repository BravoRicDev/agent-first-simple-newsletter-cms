import crypto from "crypto";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import config from "../src/config.js";
import agentRouter from "../src/routes/agent.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { query } from "../src/db.js";

describe("satelliti F0: capability registry + discovery", () => {
  let site, superadminToken, svcToken, svcReadOnlyToken, server, baseUrl;
  const unique = () => crypto.randomBytes(4).toString("hex");
  const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  before(async () => {
    // La chiave serve solo per il test del token M2M cifrato (write-only).
    config.encryptionKey = "a".repeat(64);
    site = await createTestSite("Satellite Capabilities Test");
    const superadmin = await createTestUser(site.id, "superadmin");
    const svc = await createTestUser(site.id, "admin");
    superadminToken = (await createApiToken(superadmin.id, "caps super", 30, ["read", "write"])).token;
    svcToken = (await createApiToken(svc.id, "caps svc", 30, ["read", "write"])).token;
    const ro = await createTestUser(site.id, "admin");
    svcReadOnlyToken = (await createApiToken(ro.id, "caps svc ro", 30, ["read"])).token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.locals.t = (k) => k;
      res.locals.lang = "it";
      res.locals.app = { name: "CMS" };
      next();
    });
    app.use(agentRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });

  test("create con capabilities valide → normalizzate e ritornate", async () => {
    const name = "cap-" + unique();
    const res = await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({
        name,
        origin: `https://${name}.example.test`,
        capabilities: [
          { method: "post", path: "/api/messages/send", desc: "Invia", scope: "write" },
          { method: "GET", path: "/api/messages/status" },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const sat = (await res.json()).satellite;
    assert.equal(sat.capabilities.length, 2);
    assert.equal(sat.capabilities[0].method, "POST");
    assert.equal(sat.capabilities[0].scope, "write");
    assert.equal(sat.capabilities[1].scope, "read"); // default
    assert.equal(sat.has_agent_token, false);
  });

  test("create senza capabilities → default [] (retro-compat)", async () => {
    const name = "nocap-" + unique();
    const res = await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({ name, origin: `https://${name}.example.test` }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).satellite.capabilities, []);
  });

  test("capabilities malformate → 400", async () => {
    for (const caps of [
      [{ method: "BANANA", path: "/x" }],
      [{ method: "GET", path: "no-slash" }],
      "non-un-array",
      [{ method: "GET", path: "/x", scope: "root" }],
    ]) {
      const res = await fetch(`${baseUrl}/api/agent/satellites`, {
        method: "POST",
        headers: auth(superadminToken),
        body: JSON.stringify({ name: "bad-" + unique(), origin: `https://bad-${unique()}.example.test`, capabilities: caps }),
      });
      assert.equal(res.status, 400);
    }
  });

  test("discovery directory: solo satelliti enabled; lettura ok anche read-only", async () => {
    const on = await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({
        name: "on-" + unique(),
        origin: `https://on-${unique()}.example.test`,
        capabilities: [{ method: "GET", path: "/ping", desc: "Ping", scope: "read" }],
      }),
    });
    const onSat = (await on.json()).satellite;
    const offName = "off-" + unique();
    await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({
        name: offName,
        origin: `https://${offName}.example.test`,
        enabled: false,
        capabilities: [{ method: "GET", path: "/ping" }],
      }),
    });

    const list = await fetch(`${baseUrl}/api/agent/satellites/capabilities`, { headers: auth(svcReadOnlyToken) });
    assert.equal(list.status, 200);
    const names = (await list.json()).satellites.map((s) => s.name);
    assert.ok(names.includes(onSat.name));
    assert.ok(!names.includes(offName));
    assert.ok(!names.some((n) => n.startsWith("off-")));
  });

  test("discovery singolo satellite: 200 con shape attesa; 404 se assente/disabled", async () => {
    const name = "single-" + unique();
    await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({
        name,
        origin: `https://${name}.example.test`,
        capabilities: [{ method: "POST", path: "/api/x/:id/do", desc: "X", scope: "write" }],
      }),
    });
    const one = await fetch(`${baseUrl}/api/agent/satellites/${name}/capabilities`, { headers: auth(svcToken) });
    assert.equal(one.status, 200);
    const body = await one.json();
    assert.equal(body.name, name);
    assert.equal(body.origin, `https://${name}.example.test`);
    assert.equal(body.capabilities[0].path, "/api/x/:id/do");

    const unknown = await fetch(`${baseUrl}/api/agent/satellites/inesistente-${unique()}/capabilities`, { headers: auth(svcToken) });
    assert.equal(unknown.status, 404);
  });

  test("discovery senza autenticazione → 401 (o redirect /login: comportamento pre-esistente dello stack agent)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/satellites/capabilities`, { redirect: "manual" });
    assert.ok([401, 302].includes(res.status), `status ${res.status}`);
  });

  test("agent_token è write-only: cifrato, mai in risposta", async () => {
    const name = "tok-" + unique();
    const created = await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({ name, origin: `https://${name}.example.test` }),
    });
    const sat = (await created.json()).satellite;
    const upd = await fetch(`${baseUrl}/api/agent/satellites/${sat.id}`, {
      method: "PUT",
      headers: auth(superadminToken),
      body: JSON.stringify({ agent_token: "agtok_" + unique() }),
    });
    assert.equal(upd.status, 200);
    const body = await upd.json();
    assert.equal(body.satellite.has_agent_token, true);
    assert.equal(body.satellite.agent_token, undefined);
    assert.equal(body.satellite.agent_token_enc, undefined);

    const row = (await query(
      "SELECT agent_token_enc FROM sso_satellites WHERE id = $1", [sat.id]
    )).rows[0];
    assert.ok(row.agent_token_enc.startsWith("v1:"));
    assert.ok(!row.agent_token_enc.includes("agtok_"));
  });
});
