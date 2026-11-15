import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import agentRouter from "../src/routes/agent.js";
import { discoverTools } from "../src/services/mcp-tools.js";
import { MEDIA_ROOT, VARIANTS_ROOT } from "../src/services/image-variants.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken } from "./ext-helpers.js";

describe("agent: media variants and focal point", () => {
  let site, other, user, app, rwToken, roToken;
  const siteDir = () => path.join(MEDIA_ROOT, String(site.id));
  const varDir = () => path.join(VARIANTS_ROOT, String(site.id));
  const base = () => `/api/agent/sites/${site.id}/media/fx.png`;
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    site = await createTestSite("MediaVariants");
    other = await createTestSite("MediaVariantsOther");
    user = await createTestUser(site.id, "admin");
    rwToken = await apiToken(user.id, ["read", "write"]);
    roToken = await apiToken(user.id, ["read"]);
    fs.mkdirSync(siteDir(), { recursive: true });
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#3366cc" } })
      .png().toFile(path.join(siteDir(), "fx.png"));
    app = await startApp({ routers: [agentRouter] });
  });

  after(async () => {
    app.close();
    fs.rmSync(siteDir(), { recursive: true, force: true });
    fs.rmSync(varDir(), { recursive: true, force: true });
    await closeDb();
  });

  test("GET variants before generation -> info null, eligible file", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/variants`, { headers: auth(roToken) });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.filename, "fx.png");
    assert.equal(body.info, null);
    assert.equal(body.focal, null);
  });

  test("regenerate (rw token) -> info.widths non-empty", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/variants/regenerate`, { method: "POST", headers: auth(rwToken), body: {} });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json().info.widths));
    assert.ok(r.json().info.widths.length > 0);
  });

  test("GET after generation -> srcset.webp non-empty", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/variants`, { headers: auth(roToken) });
    assert.equal(r.status, 200);
    assert.ok(r.json().srcset.webp.length > 0);
    assert.ok(r.json().info);
  });

  test("PUT focal x=0.3 y=0.7 -> 200 and GET shows it", async () => {
    const put = await httpReq(app.baseUrl, `${base()}/focal`, { method: "PUT", headers: auth(rwToken), body: { x: 0.3, y: 0.7 } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json().focal, { x: 0.3, y: 0.7 });
    const get = await httpReq(app.baseUrl, `${base()}/variants`, { headers: auth(roToken) });
    assert.deepEqual(get.json().focal, { x: 0.3, y: 0.7 });
  });

  test("PUT focal x=5 -> 400 invalid_focal", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/focal`, { method: "PUT", headers: auth(rwToken), body: { x: 5, y: 0.5 } });
    assert.equal(r.status, 400);
    assert.equal(r.json().code, "invalid_focal");
  });

  test("PUT focal clear:true -> focal null", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/focal`, { method: "PUT", headers: auth(rwToken), body: { clear: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json().focal, null);
  });

  test("read-only token PUT focal -> 403 token_scope_required", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/focal`, { method: "PUT", headers: auth(roToken), body: { x: 0.1, y: 0.1 } });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, "token_scope_required");
  });

  test("x.gif -> 400 unsupported_type", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/media/x.gif/variants`, { headers: auth(roToken) });
    assert.equal(r.status, 400);
    assert.equal(r.json().code, "unsupported_type");
  });

  test("missing file -> 404 media_not_found", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/media/nope.png/variants`, { headers: auth(roToken) });
    assert.equal(r.status, 404);
    assert.equal(r.json().code, "media_not_found");
  });

  test("cross-site -> 403", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${other.id}/media/fx.png/variants`, { headers: auth(roToken) });
    assert.equal(r.status, 403);
  });

  test("the 3 variants tools are enriched", () => {
    const tools = discoverTools();
    const paths = [
      "/api/agent/sites/:siteId/media/:filename/variants",
      "/api/agent/sites/:siteId/media/:filename/focal",
      "/api/agent/sites/:siteId/media/:filename/variants/regenerate",
    ];
    for (const p of paths) {
      const t = tools.find((x) => x.path === p);
      assert.ok(t, `tool missing for ${p}`);
      assert.equal(t.enriched, true, `not enriched: ${p}`);
    }
  });
});
