import crypto from "crypto";
import http from "node:http";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import config from "../src/config.js";
import agentRouter from "../src/routes/agent.js";
import satelliteProxyRouter from "../src/routes/satellite-proxy.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { query } from "../src/db.js";

// F1 — Proxy sincrono tra satelliti: mock del satellite target su
// 127.0.0.1:porta-casuale (la "rete interna"), registrato nel CMS con
// base_internal + capabilities + token M2M cifrato.
describe("satelliti F1: proxy /invoke", () => {
  let site, superadminToken, writeToken, readOnlyToken, svcWId;
  let target, callerSatName, targetServer, targetPort, seenCallerHeader;
  let noBaseId, closedPortSatName;
  let server, baseUrl;
  const unique = () => crypto.randomBytes(4).toString("hex");
  const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  before(async () => {
    config.encryptionKey = "b".repeat(64);
    site = await createTestSite("Satellite Proxy Test");
    const superadmin = await createTestUser(site.id, "superadmin");
    const svcW = await createTestUser(site.id, "admin"); // chiamante con write
    const svcR = await createTestUser(site.id, "admin"); // chiamante read-only
    svcWId = svcW.id;
    superadminToken = (await createApiToken(superadmin.id, "px super", 30, ["read", "write"])).token;
    writeToken = (await createApiToken(svcW.id, "px write", 30, ["read", "write"])).token;
    readOnlyToken = (await createApiToken(svcR.id, "px read", 30, ["read"])).token;

    targetServer = http.createServer((req, res) => {
      seenCallerHeader = req.headers["x-satellite-caller"];
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.url === "/api/messages/status" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "delivered" }));
        } else if (req.url === "/api/messages/send" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sent: true, echo: JSON.parse(body || "{}") }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "nope" }));
        }
      });
    });
    await new Promise((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
    targetPort = targetServer.address().port;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.locals.t = (k) => k;
      res.locals.lang = "it";
      res.locals.app = { name: "CMS" };
      next();
    });
    // Il proxy DEVE stare prima di agentRouter: il router.use("/api/agent")
    // di crm-agent.js gira il gate scope senza req.route per i path che non
    // matchano rotte precedenti, bloccando i token read-only a torto.
    app.use(satelliteProxyRouter);
    app.use(agentRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });

    // Satellite CHIAMANTE legato all'utente del token write: risolve il nome
    // per l'header X-Satellite-Caller e gli audit log.
    callerSatName = "caller-" + unique();
    await registerSatellite({
      name: callerSatName,
      origin: `https://caller-${unique()}.example.test`,
      user_id: svcWId,
    });

    // Registrazione del satellite target (senza binding utente).
    target = await registerSatellite({
      name: "target-" + unique(),
      origin: `https://target-${unique()}.example.test`,
      base_internal: `http://127.0.0.1:${targetPort}`,
      capabilities: [
        { method: "GET", path: "/api/messages/status", desc: "Stato", scope: "read" },
        { method: "POST", path: "/api/messages/send", desc: "Invia", scope: "write" },
      ],
      agent_token: "agtok_target_" + unique(),
    });

    // Satellite senza base_internal ma con capability dichiarata.
    const nb = await registerSatellite({
      name: "nobase-" + unique(),
      origin: `https://nobase-${unique()}.example.test`,
      capabilities: [{ method: "GET", path: "/ping", scope: "read" }],
    });
    noBaseId = nb.id;

    // Satellite con base_internal verso una porta chiusa.
    closedPortSatName = "closed-" + unique();
    await registerSatellite({
      name: closedPortSatName,
      origin: `https://closed-${unique()}.example.test`,
      base_internal: "http://127.0.0.1:9",
      capabilities: [{ method: "GET", path: "/ping", scope: "read" }],
      agent_token: "agtok_closed_" + unique(),
    });
  });

  after(async () => {
    server.closeAllConnections?.(); server.close();
    targetServer.closeAllConnections?.(); targetServer.close();
    await closeDb();
  });

  async function registerSatellite(payload) {
    const res = await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.satellite;
  }

  async function invoke(token, name, body) {
    return fetch(`${baseUrl}/api/agent/satellites/${name}/invoke`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify(body),
    });
  }

  test("invoke GET felice: risposta propagata, header caller impostato", async () => {
    const res = await invoke(writeToken, target.name, { path: "/api/messages/status" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 200);
    assert.equal(body.data.status, "delivered");
    assert.match(seenCallerHeader, /^caller-/);
  });

  test("invoke POST felice su endpoint write con token write", async () => {
    const res = await invoke(writeToken, target.name, {
      method: "POST",
      path: "/api/messages/send",
      data: { to: "+39333", text: "ciao" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.sent, true);
    assert.deepEqual(body.data.echo, { to: "+39333", text: "ciao" });
  });

  test("endpoint write invocato da token read-only → 403 token_scope_required", async () => {
    const res = await invoke(readOnlyToken, target.name, {
      method: "POST",
      path: "/api/messages/send",
      data: {},
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "token_scope_required");
  });

  test("token read-only PUÒ invocare endpoint read (allowlist POST)", async () => {
    const res = await invoke(readOnlyToken, target.name, { path: "/api/messages/status" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test("endpoint non dichiarato → 422 endpoint_not_declared", async () => {
    const res = await invoke(writeToken, target.name, { path: "/api/private/secret" });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, "endpoint_not_declared");
  });

  test("path traversal → 422 invalid_path (mai fuori da base_internal)", async () => {
    for (const p of ["/../etc/passwd", "/api/../../admin", "/api/x\\y"]) {
      const res = await invoke(writeToken, target.name, { path: p });
      assert.equal(res.status, 422, `path ${p}`);
      assert.equal((await res.json()).error, "invalid_path");
    }
  });

  test("target sconosciuto → 404 satellite_not_found", async () => {
    const res = await invoke(writeToken, "fantasma-" + unique(), { path: "/x" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "satellite_not_found");
  });

  test("base_internal assente → 501 satellite_not_reachable", async () => {
    const name = (await query("SELECT name FROM sso_satellites WHERE id=$1", [noBaseId])).rows[0].name;
    const res = await invoke(writeToken, name, { path: "/ping" });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error, "satellite_not_reachable");
  });

  test("target irraggiungibile (porta chiusa) → 502 bad_gateway", async () => {
    const res = await invoke(writeToken, closedPortSatName, { path: "/ping" });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "bad_gateway");
    assert.ok(["network_error", "timeout"].includes(body.detail));
  });

  test("ogni invocazione scrive audit log satellite_proxy", async () => {
    const rows = (await query(
      `SELECT new_data FROM audit_log
       WHERE entity_type='satellite_proxy' AND action='invoke'
         AND new_data->>'target' = $1
       ORDER BY id DESC LIMIT 5`,
      [target.name]
    )).rows;
    assert.ok(rows.length >= 3);
    const nd = rows[0].new_data || {};
    assert.ok(nd.path);
    assert.ok(nd.caller);
    assert.ok(Number.isInteger(nd.status));
  });

  test(":param nelle capability matchano segmenti arbitrari", async () => {
    // Aggiungo una capability con parametro al target e la invoco.
    const upd = await fetch(`${baseUrl}/api/agent/satellites/${target.id}`, {
      method: "PUT",
      headers: auth(superadminToken),
      body: JSON.stringify({
        capabilities: [
          ...(target.capabilities || []),
          { method: "GET", path: "/api/messages/:id/status", scope: "read" },
        ],
      }),
    });
    assert.equal(upd.status, 200);
    const res = await invoke(writeToken, target.name, { path: "/api/messages/42/status" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});
