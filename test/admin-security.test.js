import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken, sessionCookie } from "./ext-helpers.js";
import adminSecurityRouter from "../src/routes/admin-security.js";

describe("admin security: mfa-reset", () => {
  let siteA, siteB, admin, adminB, superadmin, collab, collabB, superB, app;

  async function enrollMfa(userId) {
    await query("INSERT INTO user_mfa (user_id, totp_enabled) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET totp_enabled = true", [userId]);
  }
  async function mfaRows(userId) {
    return (await query("SELECT user_id FROM user_mfa WHERE user_id = $1", [userId])).rows.length;
  }
  async function tokenVersion(userId) {
    return (await query("SELECT token_version FROM users WHERE id = $1", [userId])).rows[0].token_version;
  }
  function reset(targetId, cookie) {
    return httpReq(app.baseUrl, `/admin/api/users/${targetId}/mfa-reset`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: {} });
  }

  before(async () => {
    siteA = await createTestSite("SecA");
    siteB = await createTestSite("SecB");
    admin = await createTestUser(siteA.id, "admin");
    adminB = await createTestUser(siteB.id, "admin");
    superadmin = await createTestUser(siteA.id, "superadmin");
    collab = await createTestUser(siteA.id, "collaboratore");
    collabB = await createTestUser(siteB.id, "collaboratore");
    superB = await createTestUser(siteB.id, "superadmin");
    app = await startApp({ views: true, routers: [adminSecurityRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  test("admin resets collaboratore of same site -> 200, mfa rows gone, token_version bumped", async () => {
    await enrollMfa(collab.id);
    const prev = await tokenVersion(collab.id);
    const r = await reset(collab.id, await sessionCookie(admin.id));
    assert.equal(r.status, 200);
    assert.equal(await mfaRows(collab.id), 0);
    assert.equal(await tokenVersion(collab.id), prev + 1);
  });

  test("admin of another site -> 404", async () => {
    await enrollMfa(collabB.id);
    const r = await reset(collabB.id, await sessionCookie(admin.id));
    assert.equal(r.status, 404);
    assert.equal(await mfaRows(collabB.id), 1);
  });

  test("admin targeting a superadmin -> 404", async () => {
    await enrollMfa(superadmin.id);
    const r = await reset(superadmin.id, await sessionCookie(admin.id));
    assert.equal(r.status, 404);
    assert.equal(await mfaRows(superadmin.id), 1);
  });

  test("superadmin resets a user of another site -> 200", async () => {
    await enrollMfa(collabB.id);
    const r = await reset(collabB.id, await sessionCookie(superadmin.id));
    assert.equal(r.status, 200);
    assert.equal(await mfaRows(collabB.id), 0);
  });

  test("superadmin resets another superadmin -> 200", async () => {
    await enrollMfa(superB.id);
    const r = await reset(superB.id, await sessionCookie(superadmin.id));
    assert.equal(r.status, 200);
    assert.equal(await mfaRows(superB.id), 0);
  });

  test("collaboratore -> 403", async () => {
    const r = await reset(collab.id, await sessionCookie(collab.id));
    assert.equal(r.status, 403);
  });

  test("agent token -> 403 session_required", async () => {
    const tok = await apiToken(admin.id);
    const r2 = await httpReq(app.baseUrl, `/admin/api/users/${collab.id}/mfa-reset`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: {} });
    assert.equal(r2.status, 403);
    assert.equal(r2.json().error, "session_required");
  });
});
