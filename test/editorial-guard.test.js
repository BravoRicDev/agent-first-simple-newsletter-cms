import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain, apiToken, sessionCookie, makePage, noSmtp } from "./ext-helpers.js";
import { query } from "../src/db.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import { editorialGuard } from "../src/middleware/editorial-guard.js";
import agentRouter from "../src/routes/agent.js";
import pagesRoutes from "../src/routes/pages.js";

noSmtp();

describe("editorial guard", () => {
  let site, admin, collab, adminTok, collabTok, domain, app;
  let pageId, publishedPageId, tplId;
  const enc = (s) => [...s].map((c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")).join("");

  async function setWorkflow(v) { await setBlogConfig(site.id, { editorial_workflow_enabled: v }); }

  before(async () => {
    site = await createTestSite("Guard");
    admin = await createTestUser(site.id, "admin");
    collab = await createTestUser(site.id, "collaboratore");
    adminTok = await apiToken(admin.id);
    collabTok = await apiToken(collab.id);
    domain = await addDomain(site.id);
    app = await startApp({ views: true, before: (a) => a.use(editorialGuard), routers: [agentRouter, pagesRoutes] });
    const tpl = await query(
      "INSERT INTO templates (site_id, name, content) VALUES ($1, $2, $3) RETURNING id",
      [site.id, `guard-tpl-${Date.now()}`, "<p>x</p>"]
    );
    tplId = tpl.rows[0].id;
  });

  after(async () => {
    app.close();
    await closeDb();
  });

  const api = (path, token, method, body) =>
    httpReq(app.baseUrl, path, { method, headers: { Authorization: `Bearer ${token}` }, body });

  test("workflow OFF: collaboratore can publish (unchanged behavior)", async () => {
    await setWorkflow("0");
    const r = await api(`/api/agent/sites/${site.id}/pages`, collabTok, "POST",
      { url_path: `/off-${Date.now()}`, title: "Off", content: "<p>x</p>", published: true });
    assert.equal(r.status, 201, r.text);
  });

  test("workflow ON: collaboratore POST published:true -> 403, published:false -> 201", async () => {
    await setWorkflow("1");
    const denied = await api(`/api/agent/sites/${site.id}/pages`, collabTok, "POST",
      { url_path: `/on-${Date.now()}`, title: "On", content: "<p>x</p>", published: true });
    assert.equal(denied.status, 403);
    assert.equal(denied.json().error, "editorial_review_required");

    const ok = await api(`/api/agent/sites/${site.id}/pages`, collabTok, "POST",
      { url_path: `/on-draft-${Date.now()}`, title: "Draft", content: "<p>x</p>", published: false });
    assert.equal(ok.status, 201, ok.text);
    pageId = ok.json().id ?? ok.json().page?.id;
  });

  test("workflow ON: PUT unpublished page with published:true -> 403; already published page keeping true -> not 403", async () => {
    const r = await api(`/api/agent/sites/${site.id}/pages/${pageId}`, collabTok, "PUT", { published: true });
    assert.equal(r.status, 403);

    const pub = await makePage(site.id, { url_path: `/pub-${Date.now()}`, published: true });
    publishedPageId = pub.id;
    const keep = await api(`/api/agent/sites/${site.id}/pages/${publishedPageId}`, collabTok, "PUT", { published: true, title: "Keep" });
    assert.notEqual(keep.status, 403);
  });

  test("workflow ON: publish-toggle bypass forms are all 403 on unpublished page", async () => {
    const path = `/api/agent/sites/${site.id}/pages/${pageId}/publish-toggle`;
    assert.equal((await api(path, collabTok, "POST", { published: true })).status, 403);
    assert.equal((await api(path, collabTok, "POST", {})).status, 403);
    assert.equal((await api(path, collabTok, "POST", { published: "false" })).status, 403);
    assert.equal((await api(path, collabTok, "POST", { published: false })).status, 200);
  });

  test("workflow ON: bulk-publish true -> 403, false -> 200", async () => {
    const path = `/api/agent/sites/${site.id}/pages/bulk-publish`;
    assert.equal((await api(path, collabTok, "POST", { page_ids: [pageId], published: true })).status, 403);
    assert.equal((await api(path, collabTok, "POST", { page_ids: [pageId], published: false })).status, 200);
  });

  test("workflow ON: admin token can publish -> 201 create, 200 toggle", async () => {
    const created = await api(`/api/agent/sites/${site.id}/pages`, adminTok, "POST",
      { url_path: `/adm-${Date.now()}`, title: "Adm", content: "<p>x</p>", published: true });
    assert.equal(created.status, 201, created.text);
    const tog = await api(`/api/agent/sites/${site.id}/pages/${pageId}/publish-toggle`, adminTok, "POST", { published: true });
    assert.equal(tog.status, 200, tog.text);
    // ripristino: pagina di test di nuovo bozza per i casi successivi
    await api(`/api/agent/sites/${site.id}/pages/${pageId}/publish-toggle`, adminTok, "POST", { published: false });
  });

  test("workflow ON: restore of published version on unpublished page -> 403 (restore, restore-last, undo)", async () => {
    const ver = await query(
      `INSERT INTO page_versions (page_id, url_path, title, content, layout_mode, published)
       VALUES ($1, '/v', 'V', '<p>v</p>', 'wrapped', true) RETURNING id`, [pageId]);
    const vid = ver.rows[0].id;
    assert.equal((await api(`/api/agent/sites/${site.id}/pages/${pageId}/versions/${vid}/restore`, collabTok, "POST", {})).status, 403);
    assert.equal((await api(`/api/agent/sites/${site.id}/pages/${pageId}/restore-last`, collabTok, "POST", {})).status, 403);
    assert.equal((await api(`/api/agent/sites/${site.id}/pages/${pageId}/undo`, collabTok, "POST", {})).status, 403);
  });

  test("workflow ON: template instantiate published:true -> 403, published:false -> 201", async () => {
    const path = `/api/agent/sites/${site.id}/templates/${tplId}/instantiate`;
    const denied = await api(path, collabTok, "POST", { url_path: `/tpl-${Date.now()}`, published: true, values: {} });
    assert.equal(denied.status, 403);
    const ok = await api(path, collabTok, "POST", { url_path: `/tpl-ok-${Date.now()}`, published: false, values: {} });
    assert.equal(ok.status, 201, ok.text);
  });

  test("bypass: upper-case path and percent-encoded page id are still guarded", async () => {
    const upper = await api(`/API/agent/sites/${site.id}/pages`, collabTok, "POST",
      { url_path: `/up-${Date.now()}`, title: "U", content: "<p>x</p>", published: true });
    assert.equal(upper.status, 403);

    const encPath = `/api/agent/sites/${site.id}/pages/${enc(String(pageId))}/publish-toggle`;
    assert.equal((await api(encPath, collabTok, "POST", { published: true })).status, 403);
  });

  test("bypass: blog-settings toggle off by collaboratore -> 403; unchanged value -> not 403; admin -> 200 then restore '1'", async () => {
    const path = `/api/agent/sites/${site.id}/blog-settings`;
    assert.equal((await api(path, collabTok, "PUT", { editorial_workflow_enabled: "0" })).status, 403);
    assert.notEqual((await api(path, collabTok, "PUT", { editorial_workflow_enabled: "1" })).status, 403);
    const adm = await api(path, adminTok, "PUT", { editorial_workflow_enabled: "0" });
    assert.equal(adm.status, 200, adm.text);
    await setWorkflow("1");
  });

  test("admin form routes (session cookie): POST /admin/pages published=true -> 403 HTML; blog-settings off -> 403", async () => {
    const collabCookie = await sessionCookie(collab.id);
    const r = await httpReq(app.baseUrl, "/admin/pages", {
      method: "POST", host: domain, headers: { Cookie: collabCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: `url_path=${encodeURIComponent(`/x-${Date.now()}`)}&title=X&published=true`,
    });
    assert.equal(r.status, 403);
    assert.match(r.headers["content-type"] || "", /text\/html/);

    const s = await httpReq(app.baseUrl, "/admin/blog-settings", {
      method: "POST", host: domain, headers: { Cookie: collabCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: "editorial_workflow_enabled=0",
    });
    assert.equal(s.status, 403);
  });

  test("final DB state: workflow flag restored to '1'", async () => {
    const row = (await query("SELECT value FROM settings WHERE site_id = $1 AND key = 'editorial_workflow_enabled'", [site.id])).rows[0];
    assert.equal(row?.value, "1");
  });
});
