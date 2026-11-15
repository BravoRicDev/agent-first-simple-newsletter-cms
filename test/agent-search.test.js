import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken, makePage } from "./ext-helpers.js";
import agentRouter from "../src/routes/agent.js";
import { discoverTools } from "../src/services/mcp-tools.js";

describe("agent: search endpoints and MCP meta", () => {
  let site, otherSite, user, app, rwToken, rToken;
  const word = `zqsrch${crypto.randomBytes(4).toString("hex")}`;
  const draftWord = `zqdraft${crypto.randomBytes(4).toString("hex")}`;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    site = await createTestSite("Search Agent Site");
    otherSite = await createTestSite("Search Agent Other Site");
    user = await createTestUser(site.id, "admin");
    rwToken = await apiToken(user.id, ["read", "write"]);
    rToken = await apiToken(user.id, ["read"]);
    await makePage(site.id, { title: `Pagina ${word}`, content: `<p>testo ${word}</p>`, published: true });
    await makePage(site.id, { title: `Bozza ${draftWord}`, content: `<p>${draftWord}</p>`, published: false });
    app = await startApp({ routers: [agentRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  test("search finds a published page", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/search?q=${word}`, { headers: auth(rToken) });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.ok(body.total >= 1, "expected at least one hit");
    assert.ok(body.results.some((x) => x.title.includes(word)));
  });

  test("draft excluded by default, included with include_unpublished=true", async () => {
    const d = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/search?q=${draftWord}`, { headers: auth(rToken) });
    assert.equal(d.status, 200);
    assert.equal(d.json().total, 0);
    const i = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/search?q=${draftWord}&include_unpublished=true`, { headers: auth(rToken) });
    assert.equal(i.status, 200);
    assert.ok(i.json().results.some((x) => x.title.includes(draftWord)));
  });

  test("short q -> 400 invalid_query", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/search?q=a`, { headers: auth(rToken) });
    assert.equal(r.status, 400);
    assert.equal(r.json().error, "invalid_query");
  });

  test("q of 101 chars -> 400 invalid_query", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/search?q=${"a".repeat(101)}`, { headers: auth(rToken) });
    assert.equal(r.status, 400);
    assert.equal(r.json().error, "invalid_query");
  });

  test("reindex with read-only token -> 403 token_scope_required", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/search/reindex`, { method: "POST", headers: auth(rToken) });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, "token_scope_required");
  });

  test("reindex with rw token -> 200 and reindexed >= 1", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/search/reindex`, { method: "POST", headers: auth(rwToken) });
    assert.equal(r.status, 200);
    assert.ok(r.json().reindexed >= 1);
  });

  test("cross-site search -> 403", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${otherSite.id}/search?q=${word}`, { headers: auth(rToken) });
    assert.equal(r.status, 403);
  });

  test("both MCP tools are enriched", () => {
    const tools = discoverTools("en");
    for (const name of ["search_pages", "search_reindex"]) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} missing`);
      assert.equal(t.enriched, true, `${name} not enriched`);
    }
  });
});
