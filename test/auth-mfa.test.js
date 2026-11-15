import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { query } from "../src/db.js";
import config from "../src/config.js";
import { startApp, httpReq, sessionCookie, apiToken, noSmtp } from "./ext-helpers.js";
import authMfaRouter from "../src/routes/auth-mfa.js";
import { createLoginChallenge, invalidateMfaCache } from "../src/services/mfa.js";
import { totp } from "../src/services/totp.js";

describe("auth mfa / passkey router", () => {
  let site, user, app, cookie, secret, backupCodes, ticketForSuccess;
  const plusStep = () => totp(secret, { time: Date.now() + 30000 });

  before(async () => {
    noSmtp();
    config.nodeEnv = "development";
    site = await createTestSite("Auth MFA");
    user = await createTestUser(site.id, "admin");
    cookie = await sessionCookie(user.id);
    app = await startApp({ routers: [authMfaRouter] });
  });
  after(async () => { app.close(); await closeDb(); });

  const post = (path, body, headers = {}) => httpReq(app.baseUrl, path, { method: "POST", body, headers });

  test("TOTP enrollment over HTTP: begin then confirm returns 10 backup codes", async () => {
    const begin = await post("/api/auth/security/totp/begin", {}, { Cookie: cookie });
    assert.equal(begin.status, 200);
    secret = begin.json().secret;
    assert.ok(secret);
    const confirm = await post("/api/auth/security/totp/confirm", { code: totp(secret) }, { Cookie: cookie });
    assert.equal(confirm.status, 200);
    backupCodes = confirm.json().backup_codes;
    assert.equal(backupCodes.length, 10);
  });

  test("GET /api/auth/security shows totp_enabled:true", async () => {
    const r = await httpReq(app.baseUrl, "/api/auth/security", { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.json().totp_enabled, true);
  });

  test("login second step: wrong TOTP code -> 401 invalid_code", async () => {
    const ticket = await createLoginChallenge(user, { redirect_uri: "" });
    const r = await post("/api/auth/mfa/verify", { ticket, totp_code: "111111" });
    assert.equal(r.status, 401);
    assert.equal(r.json().error, "invalid_code");
  });

  test("login second step: right TOTP code (next step) -> 200 and session cookie", async () => {
    ticketForSuccess = await createLoginChallenge(user, { redirect_uri: "" });
    const r = await post("/api/auth/mfa/verify", { ticket: ticketForSuccess, totp_code: plusStep() });
    assert.equal(r.status, 200);
    assert.equal(r.json().user.id, user.id);
    assert.match(String(r.headers["set-cookie"]), /token=/);
  });

  test("a used ticket cannot be reused -> 401 invalid_ticket", async () => {
    const r = await post("/api/auth/mfa/verify", { ticket: ticketForSuccess, totp_code: plusStep() });
    assert.equal(r.status, 401);
    assert.equal(r.json().error, "invalid_ticket");
  });

  test("replay of the TOTP code consumed at enrollment -> 401", async () => {
    const ticket = await createLoginChallenge(user, { redirect_uri: "" });
    const r = await post("/api/auth/mfa/verify", { ticket, totp_code: totp(secret) });
    assert.equal(r.status, 401);
    assert.equal(r.json().error, "invalid_code");
  });

  test("garbage ticket -> 401 invalid_ticket", async () => {
    const r = await post("/api/auth/mfa/verify", { ticket: "x", totp_code: "123456" });
    assert.equal(r.status, 401);
    assert.equal(r.json().error, "invalid_ticket");
  });

  test("after 5 wrong attempts even the right code -> 401 invalid_ticket", async () => {
    const ticket = await createLoginChallenge(user, { redirect_uri: "" });
    for (let i = 0; i < 5; i++) {
      const r = await post("/api/auth/mfa/verify", { ticket, totp_code: "222222" });
      assert.equal(r.status, 401);
    }
    const r = await post("/api/auth/mfa/verify", { ticket, totp_code: plusStep() });
    assert.equal(r.status, 401);
    assert.equal(r.json().error, "invalid_ticket");
  });

  test("backup code login works once", async () => {
    const ticket = await createLoginChallenge(user, { redirect_uri: "" });
    const first = await post("/api/auth/mfa/verify", { ticket, backup_code: backupCodes[0] });
    assert.equal(first.status, 200);
    const ticket2 = await createLoginChallenge(user, { redirect_uri: "" });
    const second = await post("/api/auth/mfa/verify", { ticket: ticket2, backup_code: backupCodes[0] });
    assert.equal(second.status, 401);
    assert.equal(second.json().error, "invalid_code");
  });

  test("agent/API token on GET /api/auth/security -> 403 session_required", async () => {
    const token = await apiToken(user.id);
    const r = await httpReq(app.baseUrl, "/api/auth/security", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, "session_required");
  });

  test("totp/disable with a wrong code -> 401 and totp_enabled unchanged", async () => {
    const r = await post("/api/auth/security/totp/disable", { totp_code: "333333" }, { Cookie: cookie });
    assert.equal(r.status, 401);
    const state = await httpReq(app.baseUrl, "/api/auth/security", { headers: { Cookie: cookie } });
    assert.equal(state.json().totp_enabled, true);
  });

  test("policy on: admin cannot disable the last factor -> 409 mfa_required_by_policy", async () => {
    await query("INSERT INTO settings (site_id, key, value) VALUES ($1, 'require_2fa_admins', '1')", [site.id]);
    invalidateMfaCache(user.id);
    const r = await post("/api/auth/security/totp/disable", { backup_code: backupCodes[1] }, { Cookie: cookie });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, "mfa_required_by_policy");
    const state = await httpReq(app.baseUrl, "/api/auth/security", { headers: { Cookie: cookie } });
    assert.equal(state.json().totp_enabled, true);
  });

  test("webauthn login options without a valid ticket -> 401 invalid_ticket", async () => {
    const r = await post("/api/auth/mfa/webauthn/options", {});
    assert.equal(r.status, 401);
    assert.equal(r.json().error, "invalid_ticket");
  });

  test("webauthn login verify with unknown challenge -> 401 invalid_credential", async () => {
    const ticket = await createLoginChallenge(user, { redirect_uri: "" });
    const r = await post("/api/auth/mfa/webauthn/verify", {
      ticket, challenge_id: "00000000-0000-4000-8000-000000000000", response: {},
    });
    assert.equal(r.status, 401);
    assert.equal(r.json().error, "invalid_credential");
  });
});
