process.env.OIDC_ALLOW_PRIVATE = "1";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";

const oidc = await import("../src/services/oidc.js");
const jose = await import("jose");

const rand = () => crypto.randomBytes(4).toString("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const keyA = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyB = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubJwk = { ...keyA.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const codes = new Map();
let base = "";
let server;

// ---------- fake IdP ----------
const discoveryDoc = (issuer) => ({
  issuer,
  authorization_endpoint: base + "/authorize",
  token_endpoint: base + "/token",
  jwks_uri: base + "/jwks",
  token_endpoint_auth_methods_supported: ["client_secret_post"],
});
const idp = express();
idp.use(express.urlencoded({ extended: false }));
idp.get("/.well-known/openid-configuration", (req, res) => res.json(discoveryDoc(base)));
idp.get("/mismatch/.well-known/openid-configuration", (req, res) => res.json(discoveryDoc(base)));
idp.get("/jwks", (req, res) => res.json({ keys: [pubJwk] }));
idp.post("/token", async (req, res) => {
  const entry = codes.get(req.body.code);
  if (!entry) return res.status(400).json({ error: "invalid_grant" });
  const challenge = b64u(crypto.createHash("sha256").update(String(req.body.code_verifier || "")).digest());
  if (challenge !== entry.challenge) return res.status(400).json({ error: "invalid_grant" });
  if (req.body.client_secret !== "s3cret") return res.status(401).json({ error: "invalid_client" });
  if (req.body.redirect_uri !== oidc.redirectUri()) return res.status(400).json({ error: "invalid_redirect" });
  if (entry.redirect) return res.redirect(302, "http://evil.example/steal");
  const idToken = entry.alg === "none"
    ? `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64u(JSON.stringify(entry.claims))}.`
    : await new jose.SignJWT(entry.claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(entry.key || keyA.privateKey);
  res.json({ id_token: idToken, access_token: "x", token_type: "Bearer" });
});

function claimsFor(email, nonce) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: base, aud: "client-1", sub: "idp-sub-1", email, email_verified: true, nonce, iat: now, exp: now + 300 };
}

// Avvia authorize (state + PKCE) e registra il code nel fake IdP.
async function runFlow(provider, { email = "", mutate, key, alg, redirect } = {}) {
  const { url, state } = await oidc.buildAuthRequest(provider, {});
  const u = new URL(url);
  const code = crypto.randomBytes(16).toString("hex");
  const claims = claimsFor(email, u.searchParams.get("nonce"));
  if (mutate) mutate(claims);
  codes.set(code, { challenge: u.searchParams.get("code_challenge"), claims, key, alg, redirect });
  return { code, state };
}
const complete = (provider, flow, browserState = flow.state) =>
  oidc.completeLogin(provider, { code: flow.code, state: flow.state, browserState });

// ---------- helper dati ----------
async function mkProvider(extra = {}) {
  return oidc.createProvider({ slug: "idp-" + rand(), name: "IdP", issuer: base, client_id: "client-1", client_secret: "s3cret", ...extra });
}
async function mkUser(siteId, role = "admin", email = `u-${rand()}@d-${rand()}.example.com`) {
  const u = await createTestUser(siteId, role);
  await query("UPDATE users SET email = $1 WHERE id = $2", [email, u.id]);
  return { ...u, email };
}
const countUsersByEmail = async (email) =>
  (await query("SELECT count(*)::int AS n FROM users WHERE lower(email) = $1", [email])).rows[0].n;

describe("oidc service", () => {
  let site, siteB, provider;

  before(async () => {
    server = idp.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
    site = await createTestSite("OIDC A");
    siteB = await createTestSite("OIDC B");
    provider = await mkProvider();
  });

  after(async () => {
    server.close();
    await closeDb();
  });

  test("(1) happy path returns the EXISTING user", async () => {
    const user = await mkUser(site.id);
    const flow = await runFlow(provider, { email: user.email });
    const r = await complete(provider, flow);
    assert.equal(r.user.id, user.id);
    assert.equal(r.post_login, "");
  });

  test("(2) unknown email -> NO_LOCAL_USER and no new user row", async () => {
    const email = `nobody-${rand()}@d-${rand()}.example.com`;
    const flow = await runFlow(provider, { email });
    await assert.rejects(complete(provider, flow), { code: "NO_LOCAL_USER" });
    assert.equal(await countUsersByEmail(email), 0);
  });

  test("(3) email_verified false / missing / missing email -> EMAIL_NOT_VERIFIED", async () => {
    const user = await mkUser(site.id);
    const f1 = await runFlow(provider, { email: user.email, mutate: (c) => { c.email_verified = false; } });
    await assert.rejects(complete(provider, f1), { code: "EMAIL_NOT_VERIFIED" });
    const f2 = await runFlow(provider, { email: user.email, mutate: (c) => { delete c.email_verified; } });
    await assert.rejects(complete(provider, f2), { code: "EMAIL_NOT_VERIFIED" });
    const f3 = await runFlow(provider, { email: user.email, mutate: (c) => { delete c.email; } });
    await assert.rejects(complete(provider, f3), { code: "EMAIL_NOT_VERIFIED" });
  });

  test("(4) wrong nonce -> NONCE_MISMATCH", async () => {
    const user = await mkUser(site.id);
    const flow = await runFlow(provider, { email: user.email, mutate: (c) => { c.nonce = "wrong"; } });
    await assert.rejects(complete(provider, flow), { code: "NONCE_MISMATCH" });
  });

  test("(5) wrong aud / other key / expired / alg none / wrong iss -> rejected", async () => {
    const user = await mkUser(site.id);
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      { mutate: (c) => { c.aud = "other-client"; } },
      { key: keyB.privateKey },
      { mutate: (c) => { c.exp = now - 3600; c.iat = now - 7200; } },
      { alg: "none" },
      { mutate: (c) => { c.iss = "http://other.example.com"; } },
    ];
    for (const extra of cases) {
      const flow = await runFlow(provider, { email: user.email, ...extra });
      await assert.rejects(complete(provider, flow));
    }
  });

  test("(6) state reuse fails; wrong browserState -> STATE_MISMATCH without consuming the challenge", async () => {
    const user = await mkUser(site.id);
    const flow = await runFlow(provider, { email: user.email });
    await complete(provider, flow);
    await assert.rejects(complete(provider, flow), { code: "STATE_MISMATCH" });

    const flow2 = await runFlow(provider, { email: user.email });
    await assert.rejects(complete(provider, flow2, "other-browser-state"), { code: "STATE_MISMATCH" });
    const r = await complete(provider, flow2);
    assert.equal(r.user.id, user.id);
  });

  test("(7) allowed_email_domains: allowed passes, other domain -> DOMAIN_NOT_ALLOWED", async () => {
    const domain = `ok-${rand()}.example.com`;
    const other = `no-${rand()}.example.org`;
    const p = await mkProvider({ allowed_email_domains: [domain] });
    const user = await mkUser(site.id, "admin", `a-${rand()}@${domain}`);
    const okFlow = await runFlow(p, { email: user.email });
    const r = await complete(p, okFlow);
    assert.equal(r.user.id, user.id);
    const badFlow = await runFlow(p, { email: `b-${rand()}@${other}` });
    await assert.rejects(complete(p, badFlow), { code: "DOMAIN_NOT_ALLOWED" });
  });

  test("(8) site scoping: other-site user and superadmin via site provider -> SITE_MISMATCH; global provider OK", async () => {
    const userA = await mkUser(site.id, "admin");
    const providerB = await mkProvider({ site_id: siteB.id });
    await assert.rejects(complete(providerB, await runFlow(providerB, { email: userA.email })), { code: "SITE_MISMATCH" });

    const superA = await mkUser(site.id, "superadmin");
    const providerA = await mkProvider({ site_id: site.id });
    await assert.rejects(complete(providerA, await runFlow(providerA, { email: superA.email })), { code: "SITE_MISMATCH" });

    const providerG = await mkProvider();
    const r = await complete(providerG, await runFlow(providerG, { email: superA.email }));
    assert.equal(r.user.id, superA.id);
  });

  test("(9) PKCE: tampered verifier -> TOKEN_FAILED", async () => {
    const user = await mkUser(site.id);
    const flow = await runFlow(provider, { email: user.email });
    await query("UPDATE auth_challenges SET data = jsonb_set(data, '{verifier}', '\"tampered-verifier\"') WHERE id = $1", [flow.state]);
    await assert.rejects(complete(provider, flow), { code: "TOKEN_FAILED" });
  });

  test("(10) discovery issuer mismatch -> ISSUER_MISMATCH; loopback issuer rejected without OIDC_ALLOW_PRIVATE", async () => {
    const mismatch = base + "/mismatch";
    await assert.rejects(oidc.discover(mismatch), { code: "ISSUER_MISMATCH" });

    const saved = process.env.OIDC_ALLOW_PRIVATE;
    delete process.env.OIDC_ALLOW_PRIVATE;
    try {
      await assert.rejects(
        oidc.createProvider({ slug: "idp-" + rand(), name: "x", issuer: "http://127.0.0.1:1", client_id: "c" }),
        { code: "INVALID_PROVIDER", field: "issuer" });
      await assert.rejects(oidc.discover("http://127.0.0.1:1"));
    } finally {
      process.env.OIDC_ALLOW_PRIVATE = saved;
    }
  });

  test("(11) provider CRUD: encrypted secret, public view, validation, secret kept on update", async () => {
    const p = await mkProvider();
    assert.ok(p.client_secret_enc.startsWith("v1:"));
    const pub = oidc.publicProvider(p);
    assert.equal(pub.has_secret, true);
    assert.equal(Object.keys(pub).some((k) => k.startsWith("client_secret")), false);

    const base0 = { slug: "idp-" + rand(), name: "x", issuer: base, client_id: "c" };
    const bad = [
      { issuer: "ftp://x.example.com" },
      { issuer: base + "/?a=1" },
      { slug: "Bad Slug" },
      { scopes: "email profile" },
      { allowed_email_domains: ["notadomain"] },
    ];
    for (const b of bad) {
      await assert.rejects(oidc.createProvider({ ...base0, ...b }), { code: "INVALID_PROVIDER" });
    }

    const before = p.client_secret_enc;
    const up = await oidc.updateProvider(p.id, { name: "renamed" });
    assert.equal(up.client_secret_enc, before);
  });

  test("(12) disabled user -> USER_DISABLED", async () => {
    const user = await mkUser(site.id);
    await query("UPDATE users SET status = 'disabled' WHERE id = $1", [user.id]);
    const flow = await runFlow(provider, { email: user.email });
    await assert.rejects(complete(provider, flow), { code: "USER_DISABLED" });
  });

  test("(13) token endpoint redirect is not followed -> rejected", async () => {
    const user = await mkUser(site.id);
    const flow = await runFlow(provider, { email: user.email, redirect: true });
    await assert.rejects(complete(provider, flow));
  });

  test("(14) mapOidcError: known code -> lowercase, other -> oidc_failed", () => {
    assert.equal(oidc.mapOidcError({ code: "NO_LOCAL_USER" }), "no_local_user");
    assert.equal(oidc.mapOidcError(new Error("boom")), "oidc_failed");
  });
});
