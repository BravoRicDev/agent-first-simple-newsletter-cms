import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken, makePage, makeCategory, noSmtp } from "./ext-helpers.js";
import agentRouter from "../src/routes/agent.js";
import { discoverTools } from "../src/services/mcp-tools.js";

describe("agent feeds: GET /feeds + blog_settings_update MCP meta", () => {
  let site, other, user, otherUser, token, otherToken, app;

  before(async () => {
    noSmtp();
    site = await createTestSite("Feeds");
    other = await createTestSite("Feeds other");
    user = await createTestUser(site.id, "admin");
    otherUser = await createTestUser(other.id, "admin");
    token = await apiToken(user.id);
    otherToken = await apiToken(otherUser.id);
    app = await startApp({ routers: [agentRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  test("feeds disabled by default -> enabled:false, feeds:[]", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/feeds`, { headers: auth(token) });
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.enabled, false);
    assert.deepEqual(d.feeds, []);
  });

  test("enabling via blog-settings exposes /feed.xml and /atom.xml", async () => {
    const put = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/blog-settings`, {
      method: "PUT", headers: auth(token), body: { feed_enabled: "1" },
    });
    assert.equal(put.status, 200);
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/feeds`, { headers: auth(token) });
    const d = r.json();
    assert.equal(d.enabled, true);
    const paths = d.feeds.map((f) => f.path);
    assert.ok(paths.includes("/feed.xml"), "missing /feed.xml");
    assert.ok(paths.includes("/atom.xml"), "missing /atom.xml");
  });

  test("category with an eligible article adds /feed/<slug>.xml", async () => {
    const cat = await makeCategory(site.id, "News", `news-${Date.now()}`);
    await makePage(site.id, {
      post_type: "article", published: true, category_id: cat.id,
      published_at: new Date(Date.now() - 60_000), title: "Eligible",
    });
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/feeds`, { headers: auth(token) });
    const paths = r.json().feeds.map((f) => f.path);
    assert.ok(paths.includes(`/feed/${cat.slug}.xml`), `missing /feed/${cat.slug}.xml`);
  });

  test("cross-site user -> 403", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/feeds`, { headers: auth(otherToken) });
    assert.equal(r.status, 403);
  });

  test("discoverTools: blog_settings_update schema has new keys and kept homepage_custom_js", () => {
    const tools = discoverTools("en");
    const upd = tools.find((t) => t.name === "blog_settings_update");
    assert.ok(upd, "blog_settings_update not found");
    const keys = Object.keys(upd.inputSchema);
    for (const k of ["feed_enabled", "search_language", "editorial_workflow_enabled", "images_srcset_mode", "homepage_custom_js"]) {
      assert.ok(keys.includes(k), `missing schema key ${k}`);
    }
    const feeds = tools.find((t) => t.name === "feeds_list");
    assert.ok(feeds, "feeds_list not found");
    assert.equal(feeds.enriched, true);
  });
});
