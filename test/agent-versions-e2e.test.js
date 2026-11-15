import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { exportPublishedPages, getSiteStaticDir } from "../src/services/static-export.js";
import { snapshotPage } from "../src/services/page-versions.js";
import agentRouter from "../src/routes/agent.js";
import mcpRouter from "../src/routes/mcp.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken, addDomain, makeCategory, makePage } from "./ext-helpers.js";

const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

describe("agent: versions restore/undo/diff end-to-end (REST + MCP)", () => {
  let site, user, app, domain, cat, roToken, rwToken, articleId, otherPageId, v1Id, v2Id;
  const slug = `/versions-e2e-${Date.now()}`;
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const base = () => `/api/agent/sites/${site.id}/pages/${articleId}`;
  const row = async () => (await query("SELECT * FROM pages WHERE id = $1", [articleId])).rows[0];

  // MCP helpers (copied from test/mcp-catalog.test.js)
  let rpcId = 0;
  let baseUrl;
  async function rpc(token, method, params) {
    const res = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await res.text();
    let body;
    const m = text.match(/^data: (.*)$/m);
    try { body = JSON.parse(m ? m[1] : text); } catch { body = { _raw: text }; }
    return { status: res.status, body };
  }
  const call = (token, name, args) => rpc(token, "tools/call", { name, arguments: args });
  const payload = (r) => {
    const text = r.body.result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };

  before(async () => {
    site = await createTestSite("Versions E2E Site");
    user = await createTestUser(site.id, "admin");
    domain = await addDomain(site.id);
    cat = await makeCategory(site.id, "News", `news-${Date.now()}`);
    roToken = await apiToken(user.id, ["read"]);
    rwToken = await apiToken(user.id, ["read", "write"]);
    otherPageId = (await makePage(site.id, { title: "Other page", content: "<p>other</p>" })).id;
    app = await startApp({ routers: [agentRouter, mcpRouter] });
    baseUrl = app.baseUrl;
  });

  after(async () => { app.close(); await closeDb(); });

  test("(1) create article via REST, PUT twice -> >=2 versions, newest source='agent'", async () => {
    const created = await httpReq(app.baseUrl, `/api/agent/sites/${site.id}/pages`, {
      method: "POST", headers: auth(rwToken),
      body: { url_path: slug, title: "V1 title", content: "<p>v1 body</p>", post_type: "article", category_id: cat.id, published: true },
    });
    assert.equal(created.status, 201, created.text);
    articleId = created.json().page.id;

    const put1 = await httpReq(app.baseUrl, base(), {
      method: "PUT", headers: auth(rwToken),
      body: { url_path: slug, title: "V2 title", content: "<p>v2 body</p>", post_type: "article", category_id: cat.id, published: true },
    });
    assert.equal(put1.status, 200, put1.text);
    const put2 = await httpReq(app.baseUrl, base(), {
      method: "PUT", headers: auth(rwToken),
      body: { url_path: slug, title: "V3 title", content: "<p>v3 body</p>", post_type: "article", category_id: cat.id, published: true },
    });
    assert.equal(put2.status, 200, put2.text);

    const list = await httpReq(app.baseUrl, `${base()}/versions`, { headers: auth(roToken) });
    assert.equal(list.status, 200);
    assert.ok(list.json().versions.length >= 2, "expected >=2 versions");
    const newest = (await query(
      "SELECT source FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [articleId]
    )).rows[0];
    assert.equal(newest.source, "agent");

    v1Id = (await query(
      "SELECT id FROM page_versions WHERE page_id = $1 AND title = 'V1 title' ORDER BY created_at ASC, id ASC LIMIT 1", [articleId]
    )).rows[0].id;
    v2Id = (await query(
      "SELECT id FROM page_versions WHERE page_id = $1 AND title = 'V2 title' ORDER BY created_at ASC, id ASC LIMIT 1", [articleId]
    )).rows[0].id;
  });

  test("(2) restore older full version -> title/content/category restored, snapshot_id, /blog keeps article", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/versions/${v1Id}/restore`, {
      method: "POST", headers: auth(rwToken), body: {},
    });
    assert.equal(r.status, 200, r.text);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.ok(body.snapshot_id !== undefined && body.snapshot_id !== null, "snapshot_id missing");

    const p = await row();
    assert.equal(p.title, "V1 title");
    assert.ok(p.content.includes("v1 body"));
    assert.equal(p.category_id, cat.id);

    // Listing /blog is rendered by the running app from DB (sync is fire-and-forget: poll).
    const inBlog = await waitFor(async () => {
      const b = await httpReq(`http://127.0.0.1:${config.port}`, "/blog", { host: domain });
      return b.status === 200 && b.text.includes(slug);
    }, 10000);
    assert.ok(inBlog, "article not found in /blog listing after restore");
  });

  test("(3) restore with stale expected_updated_at -> 409 stale_page", async () => {
    const r = await httpReq(app.baseUrl, `${base()}/versions/${v2Id}/restore`, {
      method: "POST", headers: auth(rwToken), body: { expected_updated_at: "2000-01-01T00:00:00.000Z" },
    });
    assert.equal(r.status, 409);
    assert.equal(r.json().code, "stale_page");
  });

  test("(4) restore a version of ANOTHER page -> 404", async () => {
    const otherV = await snapshotPage(otherPageId, user.id, { source: "agent", label: "other" });
    const r = await httpReq(app.baseUrl, `${base()}/versions/${otherV.id}/restore`, {
      method: "POST", headers: auth(rwToken), body: {},
    });
    assert.equal(r.status, 404);
  });

  test("(5) read-only token -> 403 on restore, restore-last, undo, checkpoint", async () => {
    const vid = v2Id;
    const cases = [
      `${base()}/versions/${vid}/restore`,
      `${base()}/restore-last`,
      `${base()}/undo`,
      `${base()}/versions`,
    ];
    for (const p of cases) {
      const r = await httpReq(app.baseUrl, p, { method: "POST", headers: auth(roToken), body: {} });
      assert.equal(r.status, 403, `expected 403 on ${p}, got ${r.status}`);
    }
  });

  test("(6) undo twice is a toggle: 2nd undo returns to the state before the 1st undo", async () => {
    const before0 = (await row()).title;
    const u1 = await httpReq(app.baseUrl, `${base()}/undo`, { method: "POST", headers: auth(rwToken), body: {} });
    assert.equal(u1.status, 200, u1.text);
    const title1 = (await row()).title;
    assert.notEqual(title1, before0, "first undo must change state");

    const u2 = await httpReq(app.baseUrl, `${base()}/undo`, { method: "POST", headers: auth(rwToken), body: {} });
    assert.equal(u2.status, 200, u2.text);
    assert.equal((await row()).title, before0, "second undo must return to state before first undo");
  });

  test("(7) MCP: tools_run_read pages_version_diff and tools_run pages_restore_version succeed", async () => {
    const d = await call(rwToken, "tools_run_read", { name: "pages_version_diff", args: { site_id: site.id, page_id: articleId } });
    assert.ok(!d.body.result.isError, d.body.result.content?.[0]?.text);
    assert.ok(Array.isArray(payload(d).changed_fields), "changed_fields missing in diff");

    const rr = await call(rwToken, "tools_run", { name: "pages_restore_version", args: { site_id: site.id, page_id: articleId, version_id: v2Id } });
    assert.ok(!rr.body.result.isError, rr.body.result.content?.[0]?.text);
    assert.equal((await row()).title, "V2 title");
  });

  test("(9) restore of a legacy narrow row leaves post_type/category_id/excerpt untouched", async () => {
    const cur = await row();
    await query("UPDATE pages SET excerpt = 'keep-excerpt' WHERE id = $1", [articleId]);
    const legacy = (await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [articleId, user.id, cur.url_path, "Legacy title", "<p>legacy body</p>", "wrapped", true]
    )).rows[0];

    const r = await httpReq(app.baseUrl, `${base()}/versions/${legacy.id}/restore`, {
      method: "POST", headers: auth(rwToken), body: {},
    });
    assert.equal(r.status, 200, r.text);
    const p = await row();
    assert.equal(p.title, "Legacy title");
    assert.equal(p.post_type, "article");
    assert.equal(p.category_id, cat.id);
    assert.equal(p.excerpt, "keep-excerpt");
  });

  test("(8) restore of a version with published=false on a published page deletes the static file", async () => {
    await query("UPDATE pages SET published = true WHERE id = $1", [articleId]);
    const cur = await row();
    const staticFile = path.join(getSiteStaticDir(site.id), `${cur.url_path.replace(/^\//, "")}.html`);
    await exportPublishedPages({ siteId: site.id, pageIds: [articleId] });
    assert.ok(fs.existsSync(staticFile), `static file not exported before restore: ${staticFile}`);

    await query("UPDATE pages SET published = false WHERE id = $1", [articleId]);
    const unpubV = await snapshotPage(articleId, user.id, { source: "agent", label: "unpublished" });
    await query("UPDATE pages SET published = true WHERE id = $1", [articleId]);

    const r = await httpReq(app.baseUrl, `${base()}/versions/${unpubV.id}/restore`, {
      method: "POST", headers: auth(rwToken), body: {},
    });
    assert.equal(r.status, 200, r.text);
    assert.equal((await row()).published, false);
    const gone = await waitFor(async () => !fs.existsSync(staticFile), 5000);
    assert.ok(gone, `static file still present: ${staticFile}`);
  });
});
