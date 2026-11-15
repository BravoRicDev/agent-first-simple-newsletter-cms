import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain, sessionCookie, makePage, noSmtp } from "./ext-helpers.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import adminEditorialRouter from "../src/routes/admin-editorial.js";

describe("admin editorial router", () => {
  let site, otherSite, collab, admin, otherCollab, domain, app;

  before(async () => {
    noSmtp();
    site = await createTestSite("Editorial Admin");
    otherSite = await createTestSite("Editorial Other");
    collab = await createTestUser(site.id, "collaboratore");
    admin = await createTestUser(site.id, "admin");
    otherCollab = await createTestUser(otherSite.id, "collaboratore");
    domain = await addDomain(site.id);
    await setBlogConfig(site.id, { editorial_workflow_enabled: "1" });
    app = await startApp({ views: true, routers: [adminEditorialRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  const post = async (cookie, path, body = {}) => httpReq(app.baseUrl, path, {
    method: "POST", host: domain, headers: { Cookie: cookie, Accept: "application/json" }, body,
  });
  const get = async (cookie, path) => httpReq(app.baseUrl, path, {
    host: domain, headers: { Cookie: cookie, Accept: "application/json" },
  });

  test("collaboratore submits draft to review (POST JSON {})", async () => {
    const page = await makePage(site.id, { published: false });
    const r = await post(await sessionCookie(collab.id), `/admin/pages/${page.id}/editorial/submit`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, status: "in_review" });
  });

  test("reject without comment by admin -> 400 comment_required", async () => {
    const page = await makePage(site.id, { published: false });
    const cookieC = await sessionCookie(collab.id);
    const cookieA = await sessionCookie(admin.id);
    assert.equal((await post(cookieC, `/admin/pages/${page.id}/editorial/submit`)).status, 200);
    const r = await post(cookieA, `/admin/pages/${page.id}/editorial/reject`, { comment: "   " });
    assert.equal(r.status, 400);
    assert.equal(r.json().error, "comment_required");
  });

  test("admin approves an in_review page -> 200", async () => {
    const page = await makePage(site.id, { published: false });
    const cookieC = await sessionCookie(collab.id);
    const cookieA = await sessionCookie(admin.id);
    assert.equal((await post(cookieC, `/admin/pages/${page.id}/editorial/submit`)).status, 200);
    const r = await post(cookieA, `/admin/pages/${page.id}/editorial/approve`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, status: "approved" });
  });

  test("GET state as collaboratore of another site -> 404", async () => {
    const page = await makePage(site.id, { published: false });
    const r = await get(await sessionCookie(otherCollab.id), `/admin/pages/${page.id}/editorial/state`);
    assert.equal(r.status, 404);
  });

  test("GET state when workflow disabled -> {enabled:false}", async () => {
    const page = await makePage(site.id, { published: false });
    await setBlogConfig(site.id, { editorial_workflow_enabled: "0" });
    try {
      const r = await get(await sessionCookie(collab.id), `/admin/pages/${page.id}/editorial/state`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json(), { enabled: false });
    } finally {
      await setBlogConfig(site.id, { editorial_workflow_enabled: "1" });
    }
  });

  test("POST with non-numeric page id -> 404", async () => {
    const r = await post(await sessionCookie(collab.id), `/admin/pages/abc/editorial/submit`);
    assert.equal(r.status, 404);
  });

  test("unknown action -> 400 invalid_action", async () => {
    const page = await makePage(site.id, { published: false });
    const r = await post(await sessionCookie(collab.id), `/admin/pages/${page.id}/editorial/bogus`);
    assert.equal(r.status, 400);
    assert.equal(r.json().error, "invalid_action");
  });

  test("collaboratore cannot approve -> 403 editorial_forbidden", async () => {
    const page = await makePage(site.id, { published: false });
    const cookieC = await sessionCookie(collab.id);
    assert.equal((await post(cookieC, `/admin/pages/${page.id}/editorial/submit`)).status, 200);
    const r = await post(cookieC, `/admin/pages/${page.id}/editorial/approve`);
    assert.equal(r.status, 403);
    assert.equal(r.json().error, "editorial_forbidden");
  });
});
