import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { query } from "../src/db.js";
import { startApp, httpReq, sessionCookie } from "./ext-helpers.js";
import { mfaEnrollGuard } from "../src/middleware/mfa-enroll-guard.js";
import { beginTotpEnrollment, confirmTotpEnrollment, invalidateMfaCache } from "../src/services/mfa.js";
import { totp } from "../src/services/totp.js";

describe("mfa enrollment guard", () => {
  let site, admin, collab, app;
  before(async () => {
    site = await createTestSite("MFA Guard");
    admin = await createTestUser(site.id, "admin");
    collab = await createTestUser(site.id, "collaboratore");
    const adminRoutes = express.Router();
    adminRoutes.get("/admin/x", (req, res) => res.status(200).send("ok"));
    adminRoutes.get("/admin/security", (req, res) => res.status(200).send("ok"));
    app = await startApp({
      views: true,
      before: (a) => a.use("/admin", mfaEnrollGuard),
      routers: [adminRoutes],
    });
  });
  after(async () => { app.close(); await closeDb(); });

  test("policy off -> admin passes", async () => {
    const r = await httpReq(app.baseUrl, "/admin/x", { headers: { Cookie: await sessionCookie(admin.id) } });
    assert.equal(r.status, 200);
    assert.equal(r.text, "ok");
  });

  test("policy on + admin without factor -> redirect to /admin/security?enroll=1", async () => {
    await query("INSERT INTO settings (site_id, key, value) VALUES ($1, 'require_2fa_admins', '1')", [site.id]);
    invalidateMfaCache(admin.id);
    const r = await httpReq(app.baseUrl, "/admin/x", { headers: { Cookie: await sessionCookie(admin.id) } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/admin/security?enroll=1");
  });

  test("/admin/security is reachable while enrollment is required", async () => {
    const r = await httpReq(app.baseUrl, "/admin/security", { headers: { Cookie: await sessionCookie(admin.id) } });
    assert.equal(r.status, 200);
  });

  test("POST while enrollment is required -> 403", async () => {
    const r = await httpReq(app.baseUrl, "/admin/x", { method: "POST", headers: { Cookie: await sessionCookie(admin.id) }, body: {} });
    assert.equal(r.status, 403);
  });

  test("collaboratore is not affected by the policy", async () => {
    const r = await httpReq(app.baseUrl, "/admin/x", { headers: { Cookie: await sessionCookie(collab.id) } });
    assert.equal(r.status, 200);
  });

  test("invalid cookie -> next (route decides)", async () => {
    const r = await httpReq(app.baseUrl, "/admin/x", { headers: { Cookie: "token=not-a-jwt" } });
    assert.equal(r.status, 200);
  });

  test("after TOTP enrollment the admin passes again", async () => {
    const user = { id: admin.id, email: admin.email, site_id: site.id };
    const begin = await beginTotpEnrollment(user);
    await confirmTotpEnrollment(user, totp(begin.secret));
    const r = await httpReq(app.baseUrl, "/admin/x", { headers: { Cookie: await sessionCookie(admin.id) } });
    assert.equal(r.status, 200);
    assert.equal(r.text, "ok");
  });
});
