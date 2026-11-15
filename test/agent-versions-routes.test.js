import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { snapshotPage } from "../src/services/page-versions.js";
import { discoverTools } from "../src/services/mcp-tools.js";
import agentRouter from "../src/routes/agent.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken, makePage } from "./ext-helpers.js";

describe("agent: page versions routes (get, version-diff, checkpoint)", () => {
  let site, otherSite, user, app, pageId, otherPageId, versionId, roToken, rwToken;

  before(async () => {
    site = await createTestSite("Versions Routes Site");
    otherSite = await createTestSite("Versions Routes Other Site");
    user = await createTestUser(site.id, "admin");
    roToken = await apiToken(user.id, ["read"]);
    rwToken = await apiToken(user.id, ["read", "write"]);
    pageId = (await makePage(site.id, { title: "Versioned", content: "<p>v1</p>" })).id;
    otherPageId = (await makePage(otherSite.id, { title: "Foreign", content: "<p>x</p>" })).id;
    const v = await snapshotPage(pageId, user.id, { source: "agent", label: "seed" });
    versionId = v.id;
    app = await startApp({ routers: [agentRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  test("GET version returns content", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}/versions/${versionId}`, { headers: auth(roToken) });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json().version.content, "string");
    assert.ok(r.json().version.content.includes("v1"));
  });

  test("version of another page -> 404", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${otherPageId}/versions/${versionId}`, { headers: auth(roToken) });
    assert.equal(r.status, 404);
  });

  test("page of another site -> 403 for site-admin user", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${otherSite.id}/pages/${otherPageId}/versions/${versionId}`, { headers: auth(roToken) });
    assert.equal(r.status, 403);
  });

  test("version-diff without params after a title change reports changed_fields", async () => {
    // version-diff with no params and no versions -> 400 no_versions (checked on a fresh page)
    const freshId = (await makePage(site.id, { title: "Fresh" })).id;
    const none = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${freshId}/version-diff`, { headers: auth(roToken) });
    assert.equal(none.status, 400);
    assert.equal(none.json().code, "no_versions");

    await snapshotPage(pageId, user.id, { source: "agent", label: "before-edit" });
    await query("UPDATE pages SET title = $1 WHERE id = $2", ["Versioned renamed", pageId]);
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}/version-diff`, { headers: auth(roToken) });
    assert.equal(r.status, 200);
    assert.ok(r.json().changed_fields.some((c) => c.field === "title"));
  });

  test("version-diff from=current&to=<id> -> 200", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}/version-diff?from=current&to=${versionId}`, { headers: auth(roToken) });
    assert.equal(r.status, 200);
  });

  test("version-diff from=abc -> 400 invalid_ref", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}/version-diff?from=abc`, { headers: auth(roToken) });
    assert.equal(r.status, 400);
    assert.equal(r.json().code, "invalid_ref");
  });

  test("max_chars=abc is ignored (200)", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}/versions/${versionId}?max_chars=abc`, { headers: auth(roToken) });
    assert.equal(r.status, 200);
  });

  test("read-only token POST checkpoint -> 403 token_scope_required", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}/versions`, {
      method: "POST", headers: auth(roToken), body: { label: "nope" },
    });
    assert.equal(r.status, 403);
    assert.ok(r.text.includes("token_scope_required"));
  });

  test("rw token checkpoint -> 201 and DB row has label and source='agent'", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}/versions`, {
      method: "POST", headers: auth(rwToken), body: { label: "manual-checkpoint" },
    });
    assert.equal(r.status, 201);
    const id = r.json().version.id;
    const row = (await query("SELECT label, source FROM page_versions WHERE id = $1", [id])).rows[0];
    assert.equal(row.label, "manual-checkpoint");
    assert.equal(row.source, "agent");
  });

  test("the three new routes are registered as MCP tools", async () => {
    const dump = JSON.stringify(discoverTools("en"));
    assert.ok(dump.includes("/versions/:versionId"));
    assert.ok(dump.includes("/version-diff"));
  });
});
