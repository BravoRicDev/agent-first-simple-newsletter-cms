import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { query } from "../src/db.js";
import config from "../src/config.js";
import { startApp, httpReq, sessionCookie, noSmtp } from "./ext-helpers.js";
import authRouter from "../src/routes/auth.js";
import authMfaRouter from "../src/routes/auth-mfa.js";
import { totp } from "../src/services/totp.js";

async function seedMagicLink(userId) {
  const token = crypto.randomBytes(48).toString("hex");
  const otp = String(crypto.randomInt(100000, 999999));
  await query(
    "INSERT INTO magic_links (user_id, token, otp, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')",
    [userId, token, otp]
  );
  return { token, otp };
}

describe("login flow with optional second factor (MFA regression)", () => {
  let site, app, plainUser, mfaUser, disabledUser, mfaSecret, mfaCookie;

  before(async () => {
    noSmtp();
    site = await createTestSite("Auth Login MFA Flow");
    plainUser = await createTestUser(site.id, "admin");
    mfaUser = await createTestUser(site.id, "admin");
    disabledUser = await createTestUser(site.id, "admin");
    await query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabledUser.id]);
    mfaCookie = await sessionCookie(mfaUser.id);
    app = await startApp({
      views: true,
      before: (a) => a.use((req, res, next) => { res.locals.app = { name: "Test" }; next(); }),
      routers: [authRouter, authMfaRouter],
    });
  });
  after(async () => { app.close(); await closeDb(); });

  const post = (path, body, headers = {}) => httpReq(app.baseUrl, path, { method: "POST", body, headers });

  test("(1) user without MFA: /api/auth/verify -> 200, legacy shape, cookie set", async () => {
    const { token, otp } = await seedMagicLink(plainUser.id);
    const r = await post("/api/auth/verify", { token, otp });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.user.id, plainUser.id);
    assert.equal(body.redirect_to, null);
    assert.deepEqual(Object.keys(body).sort(), ["redirect_to", "user"]);
    assert.match(String(r.headers["set-cookie"]), /token=/);
  });

  test("(2) user with TOTP: /api/auth/verify -> mfa_required + ticket, no cookie; mfa/verify -> cookie", async () => {
    const begin = await post("/api/auth/security/totp/begin", {}, { Cookie: mfaCookie });
    assert.equal(begin.status, 200);
    mfaSecret = begin.json().secret;
    const confirm = await post("/api/auth/security/totp/confirm", { code: totp(mfaSecret) }, { Cookie: mfaCookie });
    assert.equal(confirm.status, 200);

    const { token, otp } = await seedMagicLink(mfaUser.id);
    const r = await post("/api/auth/verify", { token, otp });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.mfa_required, true);
    assert.match(body.ticket, /^[0-9a-f-]{36}$/i);
    assert.ok(Array.isArray(body.methods) && body.methods.includes("totp"));
    assert.equal(r.headers["set-cookie"], undefined);

    const second = await post("/api/auth/mfa/verify", { ticket: body.ticket, totp_code: totp(mfaSecret, { time: Date.now() + 30000 }) });
    assert.equal(second.status, 200);
    assert.equal(second.json().user.id, mfaUser.id);
    assert.match(String(second.headers["set-cookie"]), /token=/);
  });

  test("(3) magic link is consumed on first use: replay -> 401", async () => {
    const { token, otp } = await seedMagicLink(plainUser.id);
    const first = await post("/api/auth/verify", { token, otp });
    assert.equal(first.status, 200);
    const replay = await post("/api/auth/verify", { token, otp });
    assert.equal(replay.status, 401);
  });

  test("(4) disabled user -> 403 disabled:true", async () => {
    const { token, otp } = await seedMagicLink(disabledUser.id);
    const r = await post("/api/auth/verify", { token, otp });
    assert.equal(r.status, 403);
    assert.equal(r.json().disabled, true);
  });

  test("(5a) /api/agent/verify-otp for MFA user without totp_code -> 401 mfa_required", async () => {
    const { token, otp } = await seedMagicLink(mfaUser.id);
    const r = await post("/api/agent/verify-otp", { email: mfaUser.email, token, otp });
    assert.equal(r.status, 401);
    assert.equal(r.json().code, "mfa_required");
  });

  test("(5b) /api/agent/verify-otp for MFA user with valid totp_code -> 200 token", async () => {
    // Utente dedicato: il replay guard (totp_last_step) impedisce di riusare
    // gli step già consumati da mfaUser nei test (2) e (5a).
    const user2 = await createTestUser(site.id, "admin");
    const cookie2 = await sessionCookie(user2.id);
    const begin2 = await post("/api/auth/security/totp/begin", {}, { Cookie: cookie2 });
    const secret2 = begin2.json().secret;
    const confirm2 = await post("/api/auth/security/totp/confirm", { code: totp(secret2) }, { Cookie: cookie2 });
    assert.equal(confirm2.status, 200);
    const { token, otp } = await seedMagicLink(user2.id);
    const r = await post("/api/agent/verify-otp", {
      email: user2.email, token, otp, totp_code: totp(secret2, { time: Date.now() + 30000 }),
    });
    assert.equal(r.status, 200);
    assert.ok(r.json().token);
  });

  test("(5c) /api/agent/verify-otp for user without MFA -> 200 token (unchanged)", async () => {
    const { token, otp } = await seedMagicLink(plainUser.id);
    const r = await post("/api/agent/verify-otp", { email: plainUser.email, token, otp });
    assert.equal(r.status, 200);
    assert.ok(r.json().token);
  });

  test("(6a) GET /login/verify?ticket=<uuid> renders the ticket", async () => {
    const uuid = crypto.randomUUID();
    const r = await httpReq(app.baseUrl, `/login/verify?ticket=${uuid}`);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`id="ticketInit" value="${uuid}"`));
  });

  test("(6b) GET /login/verify?ticket=<script> renders an EMPTY ticket value", async () => {
    const r = await httpReq(app.baseUrl, "/login/verify?ticket=" + encodeURIComponent("<script>"));
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('id="ticketInit" value=""'));
    assert.ok(!r.text.includes("<script>alert"));
  });
});
