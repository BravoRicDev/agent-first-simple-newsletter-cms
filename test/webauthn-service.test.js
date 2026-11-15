import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { query } from "../src/db.js";
import config from "../src/config.js";
import * as wa from "../src/services/webauthn.js";

const fakeReq = (host = "localhost:3005") => ({
  hostname: "localhost", protocol: "http", ip: "127.0.0.1",
  get: (h) => (h.toLowerCase() === "host" ? host : undefined),
});
const rid = () => crypto.randomBytes(6).toString("hex");

describe("webauthn service", () => {
  const ctx = {};
  let site, envBackup, nodeEnvBackup;

  before(async () => {
    nodeEnvBackup = config.nodeEnv;
    config.nodeEnv = "development";
    envBackup = { id: process.env.WEBAUTHN_RP_ID, origin: process.env.WEBAUTHN_ORIGIN };
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;
    site = await createTestSite("WebAuthn");
    ctx.userA = await createTestUser(site.id, "admin");
    ctx.userB = await createTestUser(site.id, "admin");
  });

  after(async () => {
    if (envBackup.id !== undefined) process.env.WEBAUTHN_RP_ID = envBackup.id;
    if (envBackup.origin !== undefined) process.env.WEBAUTHN_ORIGIN = envBackup.origin;
    config.nodeEnv = nodeEnvBackup;
    await closeDb();
  });

  test("rpFromRequest derives rpID and origin from the Host header (development)", () => {
    const r = wa.rpFromRequest(fakeReq("localhost:3005"));
    assert.equal(r.rpID, "localhost");
    assert.equal(r.origin, "http://localhost:3005");
  });

  test("rpFromRequest rejects an invalid Host header", () => {
    assert.throws(() => wa.rpFromRequest(fakeReq("bad host")), (e) => e.code === "INVALID_HOST");
  });

  test("rpFromRequest uses WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN when both are set", () => {
    process.env.WEBAUTHN_RP_ID = "example.test";
    process.env.WEBAUTHN_ORIGIN = "https://example.test";
    try {
      const r = wa.rpFromRequest(fakeReq("other:3005"));
      assert.equal(r.rpID, "example.test");
      assert.equal(r.origin, "https://example.test");
    } finally {
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_ORIGIN;
    }
  });

  test("rpFromRequest in production uses MAGIC_LINK_BASE_URL instead of the Host header", () => {
    config.nodeEnv = "production";
    try {
      const u = new URL(config.magicLinkBaseUrl);
      const r = wa.rpFromRequest(fakeReq("attacker.test:9999"));
      assert.equal(r.rpID, u.hostname);
      assert.equal(r.origin, u.origin);
    } finally {
      config.nodeEnv = "development";
    }
  });

  test("beginRegistration returns options and stores a webauthn_reg challenge", async () => {
    const { options, challenge_id } = await wa.beginRegistration(ctx.userA, fakeReq());
    assert.equal(typeof options.challenge, "string");
    assert.equal(options.rp.id, "localhost");
    assert.equal(options.user.name, ctx.userA.email);
    assert.equal(options.attestation, "none");
    const row = (await query("SELECT kind, user_id FROM auth_challenges WHERE id = $1", [challenge_id])).rows[0];
    assert.equal(row.kind, "webauthn_reg");
    assert.equal(row.user_id, ctx.userA.id);
  });

  test("finishRegistration stores the credential; replaying the same challenge is rejected", async () => {
    const credId = `cred-${rid()}`;
    const fakeVerify = async () => ({
      verified: true,
      registrationInfo: {
        credential: { id: credId, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialDeviceType: "singleDevice", credentialBackedUp: false,
      },
    });
    const { challenge_id } = await wa.beginRegistration(ctx.userA, fakeReq());
    const out = await wa.finishRegistration(ctx.userA, fakeReq(), { challengeId: challenge_id, response: { response: {} }, name: "Mio" }, { verifyRegistrationResponse: fakeVerify });
    assert.deepEqual(out, { ok: true });
    const row = (await query("SELECT public_key, name FROM webauthn_credentials WHERE credential_id = $1", [credId])).rows[0];
    assert.equal(row.public_key, "AQID");
    assert.equal(row.name, "Mio");
    ctx.credA = credId;

    await assert.rejects(
      wa.finishRegistration(ctx.userA, fakeReq(), { challengeId: challenge_id, response: {}, name: "x" }, { verifyRegistrationResponse: fakeVerify }),
      (e) => e.code === "INVALID_CHALLENGE");
  });

  test("finishRegistration rejects a challenge issued to another user", async () => {
    const { challenge_id } = await wa.beginRegistration(ctx.userA, fakeReq());
    await assert.rejects(
      wa.finishRegistration(ctx.userB, fakeReq(), { challengeId: challenge_id, response: {} }, { verifyRegistrationResponse: async () => ({ verified: true }) }),
      (e) => e.code === "INVALID_CHALLENGE");
  });

  test("finishRegistration rejects an expired challenge", async () => {
    const { challenge_id } = await wa.beginRegistration(ctx.userA, fakeReq());
    await query("UPDATE auth_challenges SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [challenge_id]);
    await assert.rejects(
      wa.finishRegistration(ctx.userA, fakeReq(), { challengeId: challenge_id, response: {} }, { verifyRegistrationResponse: async () => ({ verified: true }) }),
      (e) => e.code === "INVALID_CHALLENGE");
  });

  test("beginAuthentication lists the user's credentials in allowCredentials", async () => {
    const { options, challenge_id } = await wa.beginAuthentication(fakeReq(), { userId: ctx.userA.id });
    const ids = (options.allowCredentials || []).map((c) => c.id);
    assert.ok(ids.includes(ctx.credA));
    const row = (await query("SELECT user_id FROM auth_challenges WHERE id = $1", [challenge_id])).rows[0];
    assert.equal(row.user_id, ctx.userA.id);
  });

  test("finishAuthentication updates the counter and returns the user id", async () => {
    const { challenge_id } = await wa.beginAuthentication(fakeReq(), { userId: ctx.userA.id });
    const out = await wa.finishAuthentication(fakeReq(), { challengeId: challenge_id, response: { id: ctx.credA }, expectUserId: ctx.userA.id }, {
      verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 7 } }),
    });
    assert.equal(out.userId, ctx.userA.id);
    const row = (await query("SELECT counter FROM webauthn_credentials WHERE credential_id = $1", [ctx.credA])).rows[0];
    assert.equal(Number(row.counter), 7);
  });

  test("finishAuthentication with expectUserId of another user -> INVALID_CHALLENGE", async () => {
    const { challenge_id } = await wa.beginAuthentication(fakeReq(), { userId: ctx.userA.id });
    await assert.rejects(
      wa.finishAuthentication(fakeReq(), { challengeId: challenge_id, response: { id: ctx.credA }, expectUserId: ctx.userB.id }, {
        verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 8 } }),
      }),
      (e) => e.code === "INVALID_CHALLENGE");
  });

  test("finishAuthentication with unknown credential id -> UNKNOWN_CREDENTIAL", async () => {
    const { challenge_id } = await wa.beginAuthentication(fakeReq(), { userId: ctx.userA.id });
    await assert.rejects(
      wa.finishAuthentication(fakeReq(), { challengeId: challenge_id, response: { id: `nope-${rid()}` } }, {
        verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
      }),
      (e) => e.code === "UNKNOWN_CREDENTIAL");
  });

  test("finishAuthentication with verified:false -> VERIFICATION_FAILED and the challenge stays consumed", async () => {
    const { challenge_id } = await wa.beginAuthentication(fakeReq(), { userId: ctx.userA.id });
    await assert.rejects(
      wa.finishAuthentication(fakeReq(), { challengeId: challenge_id, response: { id: ctx.credA } }, {
        verifyAuthenticationResponse: async () => ({ verified: false }),
      }),
      (e) => e.code === "VERIFICATION_FAILED");
    await assert.rejects(
      wa.finishAuthentication(fakeReq(), { challengeId: challenge_id, response: { id: ctx.credA } }, {
        verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 9 } }),
      }),
      (e) => e.code === "INVALID_CHALLENGE");
  });

  test("requireUV:true is forwarded as requireUserVerification:true", async () => {
    const { challenge_id } = await wa.beginAuthentication(fakeReq(), { userId: ctx.userA.id });
    let seen = null;
    await wa.finishAuthentication(fakeReq(), { challengeId: challenge_id, response: { id: ctx.credA }, requireUV: true }, {
      verifyAuthenticationResponse: async (args) => { seen = args; return { verified: true, authenticationInfo: { newCounter: 10 } }; },
    });
    assert.equal(seen.requireUserVerification, true);
  });

  test("deletePasskey of another user's row deletes nothing; owner deletes it", async () => {
    const idRow = (await query("SELECT id FROM webauthn_credentials WHERE credential_id = $1", [ctx.credA])).rows[0];
    assert.equal(await wa.deletePasskey(ctx.userB.id, idRow.id), false);
    const still = (await query("SELECT id FROM webauthn_credentials WHERE credential_id = $1", [ctx.credA])).rows;
    assert.equal(still.length, 1);
    assert.equal(await wa.deletePasskey(ctx.userA.id, idRow.id), true);
    const gone = (await query("SELECT id FROM webauthn_credentials WHERE credential_id = $1", [ctx.credA])).rows;
    assert.equal(gone.length, 0);
  });
});
