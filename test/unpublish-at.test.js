import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain, apiToken, makePage } from "./ext-helpers.js";
import { query } from "../src/db.js";
import agentRouter from "../src/routes/agent.js";
import publicRouter, { publicCatchAllRouter } from "../src/routes/serve.js";
import { runUnpublishDue } from "../src/services/scheduled-unpublish.js";
import { discoverTools } from "../src/services/mcp-tools.js";

const HOUR = 3600 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

describe("unpublish_at end-to-end", () => {
  let site, user, app, domain, token;

  // Pagina standalone pubblicata, con unpublish_at nel futuro (+1h)
  async function makeStandalone(extra = {}) {
    return makePage(site.id, {
      url_path: `/u-${Math.random().toString(36).slice(2, 10)}`,
      title: "Unpub",
      content: "<html><head></head><body>HELLO</body></html>",
      published: true,
      extra: { layout_mode: "standalone", unpublish_at: iso(HOUR), ...extra },
    });
  }

  async function expire(pageId) {
    await query("UPDATE pages SET unpublish_at = NOW() - interval '1 minute' WHERE id = $1", [pageId]);
  }

  const auth = () => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    site = await createTestSite("Unpublish");
    user = await createTestUser(site.id, "superadmin");
    domain = await addDomain(site.id);
    token = await apiToken(user.id);
    app = await startApp({ routers: [agentRouter, publicRouter, publicCatchAllRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  test("1. POST with future unpublish_at -> 201, GET returns same value", async () => {
    const target = iso(HOUR);
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages`, {
      method: "POST", headers: auth(),
      body: { url_path: `/c1-${Date.now()}`, title: "C1", content: "<p>x</p>", published: true, unpublish_at: target },
    });
    assert.equal(r.status, 201, r.text);
    const created = r.json().page ?? r.json();
    const pageId = created.page_id ?? created.id;
    const g = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${pageId}`, { headers: auth() });
    assert.equal(g.status, 200);
    assert.ok(g.json().page.unpublish_at, "unpublish_at must not be null");
    assert.equal(new Date(g.json().page.unpublish_at).getTime(), new Date(target).getTime());
  });

  test("2. POST with past unpublish_at -> 400 invalid_schedule", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages`, {
      method: "POST", headers: auth(),
      body: { url_path: `/c2-${Date.now()}`, title: "C2", unpublish_at: iso(-HOUR) },
    });
    assert.equal(r.status, 400, r.text);
    const j = r.json();
    assert.equal(j.code, "invalid_schedule");
    assert.equal(j.field, "unpublish_at");
  });

  test("3. POST with unpublish_at before publish_at -> 400", async () => {
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages`, {
      method: "POST", headers: auth(),
      body: { url_path: `/c3-${Date.now()}`, title: "C3", publish_at: iso(2 * HOUR), unpublish_at: iso(HOUR) },
    });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json().code, "invalid_schedule");
  });

  test("4. PUT without unpublish_at keeps it; null clears; unchanged past value accepted", async () => {
    const page = await makePage(site.id, { url_path: `/c4-${Date.now()}`, title: "C4", published: false, extra: { unpublish_at: iso(HOUR) } });
    const base = `/api/agent/sites/${site.id}/pages/${page.id}`;

    // PUT senza unpublish_at -> invariato
    let r = await httpReq(app.baseUrl, base, { method: "PUT", headers: auth(), body: { url_path: page.url_path, title: "C4b", content: "<p>y</p>" } });
    assert.equal(r.status, 200, r.text);
    let row = (await query("SELECT unpublish_at FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.ok(row.unpublish_at, "unpublish_at must be kept");

    // PUT con null -> azzerato
    r = await httpReq(app.baseUrl, base, { method: "PUT", headers: auth(), body: { url_path: page.url_path, title: "C4c", unpublish_at: null } });
    assert.equal(r.status, 200, r.text);
    row = (await query("SELECT unpublish_at FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(row.unpublish_at, null);

    // Valore passato nel passato, salvato via SQL; PUT con lo stesso valore -> accettato
    const pastSec = new Date(Date.now() - HOUR);
    pastSec.setMilliseconds(0);
    await query("UPDATE pages SET unpublish_at = $1 WHERE id = $2", [pastSec.toISOString(), page.id]);
    r = await httpReq(app.baseUrl, base, { method: "PUT", headers: auth(), body: { url_path: page.url_path, title: "C4d", unpublish_at: pastSec.toISOString() } });
    assert.equal(r.status, 200, r.text);
    row = (await query("SELECT unpublish_at FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(new Date(row.unpublish_at).getTime(), pastSec.getTime());
  });

  test("5. live serving: 200 before expiry, 302 after expiry", async () => {
    const page = await makeStandalone();
    let r = await httpReq(app.baseUrl, page.url_path, { host: domain });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes("HELLO"));

    await expire(page.id);
    r = await httpReq(app.baseUrl, page.url_path, { host: domain });
    assert.equal(r.status, 302, `expected 302, got ${r.status}`);
  });

  test("6. publish-toggle to true clears expired unpublish_at", async () => {
    const page = await makePage(site.id, { url_path: `/c6-${Date.now()}`, title: "C6", published: false });
    await query("UPDATE pages SET unpublish_at = NOW() - interval '1 minute' WHERE id = $1", [page.id]);
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages/${page.id}/publish-toggle`, {
      method: "POST", headers: auth(), body: { published: true },
    });
    assert.equal(r.status, 200, r.text);
    const row = (await query("SELECT published, unpublish_at FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(row.published, true);
    assert.equal(row.unpublish_at, null);
  });

  test("7. GET pages?fields=id,unpublish_at includes the field", async () => {
    const page = await makeStandalone();
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages?fields=id,unpublish_at`, { headers: auth() });
    assert.equal(r.status, 200, r.text);
    const hit = r.json().pages.find((p) => p.id === page.id);
    assert.ok(hit, "page must be listed");
    assert.ok("unpublish_at" in hit);
    assert.ok(hit.unpublish_at);
  });

  test("8. MCP meta: pages_create exposes unpublish_at", () => {
    const tool = discoverTools("en").find((t) => t.name === "pages_create");
    assert.ok(tool, "pages_create tool must exist");
    assert.ok(tool.inputSchema.unpublish_at !== undefined);
  });

  test("9. default GET pages list does NOT include the new fields", async () => {
    await makeStandalone();
    const r = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages`, { headers: auth() });
    assert.equal(r.status, 200, r.text);
    const pages = r.json().pages;
    assert.ok(pages.length > 0);
    for (const p of pages) {
      assert.ok(!("unpublish_at" in p), "unpublish_at must not be in default list");
      assert.ok(!("publish_at" in p), "publish_at must not be in default list");
      assert.ok(!("editorial_status" in p), "editorial_status must not be in default list");
    }
    const f = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages?fields=id,unpublish_at,editorial_status`, { headers: auth() });
    assert.equal(f.status, 200, f.text);
    const first = f.json().pages[0];
    assert.ok("unpublish_at" in first);
    assert.ok("editorial_status" in first);
  });

  test("10. expired page is removed from sitemap", async () => {
    const page = await makeStandalone();
    let r = await httpReq(app.baseUrl, "/sitemap.xml", { host: domain });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes(page.url_path), "live page must be in sitemap before expiry");

    await expire(page.id);
    r = await httpReq(app.baseUrl, "/sitemap.xml", { host: domain });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(page.url_path), "expired page must not be in sitemap");
  });

  test("11. scheduler end state: expired page unpublished and cleared", async () => {
    const page = await makeStandalone();
    await expire(page.id);
    await runUnpublishDue();
    const row = (await query("SELECT published, unpublish_at FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(row.published, false);
    assert.equal(row.unpublish_at, null);
    const r = await httpReq(app.baseUrl, page.url_path, { host: domain });
    assert.equal(r.status, 302);
  });
});
