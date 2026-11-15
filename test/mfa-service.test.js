import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { query } from "../src/db.js";
import { encryptSecret } from "../src/services/crypto.js";
import { totp } from "../src/services/totp.js";
import * as mfa from "../src/services/mfa.js";

let encryptionAvailable = true;
try { encryptSecret("probe"); } catch (e) { if (e.code === "ENCRYPTION_KEY_MISSING") encryptionAvailable = false; else throw e; }

describe("mfa service", { skip: !encryptionAvailable && "ENCRYPTION_KEY missing" }, () => {
  const ctx = {};
  let site;

  before(async () => {
    site = await createTestSite("MFA");
    ctx.user = await createTestUser(site.id, "admin");
  });

  after(async () => { await closeDb(); });

  test("enroll flow: begin, confirm, backup codes, encrypted storage", async () => {
    const begin = await mfa.beginTotpEnrollment(ctx.user);
    assert.equal(begin.secret.length, 32);
    assert.ok(begin.qr_data_url.startsWith("data:image/png;base64,"));
    ctx.secret = begin.secret;

    const conf = await mfa.confirmTotpEnrollment(ctx.user, totp(begin.secret));
    assert.equal(conf.backup_codes.length, 10);
    for (const c of conf.backup_codes) assert.match(c, /^[0-9a-f]{5}-[0-9a-f]{5}$/);
    ctx.backup = conf.backup_codes;

    assert.equal(await mfa.hasSecondFactor(ctx.user.id), true);
    const row = (await query("SELECT totp_secret_enc FROM user_mfa WHERE user_id = $1", [ctx.user.id])).rows[0];
    assert.ok(row.totp_secret_enc.startsWith("v1:"));
    assert.ok(!row.totp_secret_enc.includes(begin.secret));
  });

  test("begin again after enable rejects ALREADY_ENABLED", async () => {
    await assert.rejects(mfa.beginTotpEnrollment(ctx.user), (e) => e.code === "ALREADY_ENABLED");
  });

  test("TOTP replay protection: next step accepted once, repeat rejected, wrong code rejected", async () => {
    const next = totp(ctx.secret, { time: Date.now() + 30000 });
    assert.equal(await mfa.verifyTotpForUser(ctx.user.id, next), true);
    assert.equal(await mfa.verifyTotpForUser(ctx.user.id, next), false);
    const wrong = String((Number(totp(ctx.secret)) + 1) % 1000000).padStart(6, "0");
    assert.equal(await mfa.verifyTotpForUser(ctx.user.id, wrong), false);
  });

  test("backup code works once", async () => {
    assert.equal(await mfa.consumeBackupCode(ctx.user.id, ctx.backup[0]), true);
    assert.equal(await mfa.consumeBackupCode(ctx.user.id, ctx.backup[0]), false);
  });

  test("generateBackupCodes invalidates the old codes", async () => {
    ctx.backup2 = await mfa.generateBackupCodes(ctx.user.id);
    assert.equal(ctx.backup2.length, 10);
    assert.equal(await mfa.consumeBackupCode(ctx.user.id, ctx.backup[1]), false);
    assert.equal(await mfa.consumeBackupCode(ctx.user.id, ctx.backup2[0]), true);
  });

  test("lockout after 8 failures, then unlock restores backup code and resets fail_count", async () => {
    for (let i = 0; i < 8; i++) {
      assert.equal(await mfa.verifySecondFactor(ctx.user.id, { totp_code: "111111" }), false);
    }
    assert.equal(await mfa.verifySecondFactor(ctx.user.id, { backup_code: ctx.backup2[1] }), false);

    await query("UPDATE user_mfa SET locked_until = NOW() - interval '1 second' WHERE user_id = $1", [ctx.user.id]);
    assert.equal(await mfa.verifySecondFactor(ctx.user.id, { backup_code: ctx.backup2[1] }), true);
    const st = (await query("SELECT fail_count FROM user_mfa WHERE user_id = $1", [ctx.user.id])).rows[0];
    assert.equal(st.fail_count, 0);
  });

  test("getLoginSecondFactor lists totp and backup methods", async () => {
    const lf = await mfa.getLoginSecondFactor(ctx.user);
    assert.equal(lf.required, true);
    assert.deepEqual(lf.methods, ["totp", "backup"]);
  });

  test("policy: default off, site setting on, env on, needsEnrollment", async () => {
    const savedEnv = process.env.REQUIRE_2FA_ADMINS;
    try {
      delete process.env.REQUIRE_2FA_ADMINS;
      await query("DELETE FROM settings WHERE site_id = $1 AND key = 'require_2fa_admins'", [site.id]);
      assert.equal((await mfa.getMfaPolicy(ctx.user)).required, false);

      const admin2 = await createTestUser(site.id, "admin");
      await query(
        "INSERT INTO settings (site_id, key, value) VALUES ($1, 'require_2fa_admins', '1') ON CONFLICT (site_id, key) DO UPDATE SET value = '1'",
        [site.id]);
      assert.equal((await mfa.getMfaPolicy(admin2)).required, true);
      mfa.invalidateMfaCache();
      assert.equal(await mfa.needsEnrollment(admin2), true);

      // passkey counts as second factor: needsEnrollment becomes false
      await query(
        "INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES ($1, $2, 'x')",
        [admin2.id, `cred-${admin2.id}-${Date.now()}`]);
      mfa.invalidateMfaCache(admin2.id);
      assert.equal(await mfa.needsEnrollment(admin2), false);

      const collab = await createTestUser(site.id, "collaboratore");
      assert.equal((await mfa.getMfaPolicy(collab)).required, false);
      mfa.invalidateMfaCache();
      assert.equal(await mfa.needsEnrollment(collab), false);

      await query("DELETE FROM settings WHERE site_id = $1 AND key = 'require_2fa_admins'", [site.id]);
      process.env.REQUIRE_2FA_ADMINS = "1";
      assert.equal((await mfa.getMfaPolicy(ctx.user)).required, true);
    } finally {
      if (savedEnv === undefined) delete process.env.REQUIRE_2FA_ADMINS;
      else process.env.REQUIRE_2FA_ADMINS = savedEnv;
      mfa.invalidateMfaCache();
    }
  });

  test("challenge lifecycle", async () => {
    const c1 = await mfa.createChallenge(ctx.user.id, "test_kind", { a: 1 }, 300);
    assert.ok(await mfa.getChallenge(c1, "test_kind"));
    assert.equal(await mfa.getChallenge(c1, "other_kind"), null);
    for (let i = 0; i < 5; i++) await mfa.bumpChallengeAttempts(c1);
    assert.equal(await mfa.getChallenge(c1, "test_kind"), null);

    const c2 = await mfa.createChallenge(ctx.user.id, "test_kind", {}, 300);
    assert.equal(await mfa.consumeChallenge(c2), true);
    assert.equal(await mfa.consumeChallenge(c2), false);

    const c3 = await mfa.createChallenge(ctx.user.id, "test_kind", {}, 300);
    await query("UPDATE auth_challenges SET expires_at = NOW() - interval '1 second' WHERE id = $1", [c3]);
    assert.equal(await mfa.getChallenge(c3, "test_kind"), null);

    assert.equal(await mfa.getChallenge("not-a-uuid", "test_kind"), null);
    await mfa.bumpChallengeAttempts("not-a-uuid");
    assert.equal(await mfa.consumeChallenge("not-a-uuid"), false);

    const lc = await mfa.createLoginChallenge(ctx.user, { redirect_uri: "/x" });
    const got = await mfa.getChallenge(lc, "mfa_login");
    assert.equal(got.data.redirect_uri, "/x");
  });

  test("disableTotp removes factor and backup codes", async () => {
    await mfa.disableTotp(ctx.user);
    assert.equal(await mfa.hasSecondFactor(ctx.user.id), false);
    const bc = (await query("SELECT COUNT(*)::int AS n FROM user_backup_codes WHERE user_id = $1", [ctx.user.id])).rows[0].n;
    assert.equal(bc, 0);
  });

  test("resetMfa removes mfa, backup codes and passkeys and bumps token_version", async () => {
    await query(
      "INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES ($1, $2, 'x')",
      [ctx.user.id, `reset-${ctx.user.id}-${Date.now()}`]);
    const before = (await query("SELECT token_version FROM users WHERE id = $1", [ctx.user.id])).rows[0].token_version;
    const admin = await createTestUser(site.id, "superadmin");
    await mfa.resetMfa(ctx.user.id, admin);
    const after = (await query("SELECT token_version FROM users WHERE id = $1", [ctx.user.id])).rows[0].token_version;
    assert.equal(after, before + 1);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM user_mfa WHERE user_id = $1", [ctx.user.id])).rows[0].n, 0);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM user_backup_codes WHERE user_id = $1", [ctx.user.id])).rows[0].n, 0);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1", [ctx.user.id])).rows[0].n, 0);
    const st = await mfa.getMfaState(ctx.user.id);
    assert.deepEqual(st, { totp_enabled: false, passkeys: 0, backup_remaining: 0 });
  });
});
