import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken } from "./ext-helpers.js";
import agentRouter from "../src/routes/agent.js";
import { discoverTools } from "../src/services/mcp-tools.js";

describe("GET /api/agent/openapi.json", () => {
  let site, user, app, token;

  before(async () => {
    site = await createTestSite("OpenAPI Route Site");
    user = await createTestUser(site.id, "admin");
    token = await apiToken(user.id);
    app = await startApp({ routers: [agentRouter] });
  });
  after(async () => { app.close(); await closeDb(); });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test("200 json with openapi 3.1.0 and etag", async () => {
    const r = await httpReq(app.baseUrl, "/api/agent/openapi.json", { headers: auth() });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    assert.equal(r.json().openapi, "3.1.0");
    assert.ok(r.headers["etag"]);
  });

  test("If-None-Match with current etag -> 304", async () => {
    const first = await httpReq(app.baseUrl, "/api/agent/openapi.json", { headers: auth() });
    const r = await httpReq(app.baseUrl, "/api/agent/openapi.json", {
      headers: { ...auth(), "If-None-Match": first.headers["etag"] },
    });
    assert.equal(r.status, 304);
  });

  test("no Authorization -> 401", async () => {
    const r = await httpReq(app.baseUrl, "/api/agent/openapi.json");
    assert.equal(r.status, 401);
  });

  test("?area=content keeps only content operations and is smaller", async () => {
    const full = await httpReq(app.baseUrl, "/api/agent/openapi.json", { headers: auth() });
    const r = await httpReq(app.baseUrl, "/api/agent/openapi.json?area=content", { headers: auth() });
    assert.equal(r.status, 200);
    const doc = r.json();
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    assert.ok(ops.length > 0);
    for (const op of ops) assert.deepEqual(op.tags, ["content"]);
    assert.ok(r.buffer.length < full.buffer.length);
  });

  test("?lang=it uses Italian descriptions", async () => {
    const r = await httpReq(app.baseUrl, "/api/agent/openapi.json?lang=it", { headers: auth() });
    assert.equal(r.status, 200);
    const op = Object.values(r.json().paths).flatMap((p) => Object.values(p)).find((o) => o.operationId === "pages_get");
    assert.ok(op, "pages_get operation present");
    const itTool = discoverTools("it").find((t) => t.name === "pages_get");
    assert.equal(op.description, itTool.description);
  });

  test("invalid area (path traversal) is ignored -> full document", async () => {
    const full = await httpReq(app.baseUrl, "/api/agent/openapi.json", { headers: auth() });
    const r = await httpReq(app.baseUrl, "/api/agent/openapi.json?area=../../x", { headers: auth() });
    assert.equal(r.status, 200);
    assert.equal(r.buffer.length, full.buffer.length);
  });
});
