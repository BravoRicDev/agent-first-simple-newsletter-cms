process.env.OIDC_ALLOW_PRIVATE = "1";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain, apiToken, sessionCookie } from "./ext-helpers.js";

const oidc = await import("../src/services/oidc.js");
const { default: authOidcRouter } = await import("../src/routes/auth-oidc.js");
const jose = await import("jose");

const rand = () => crypto.randomBytes(4).toString("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const keyA = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubJwk = { ...keyA.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const codes = new Map();
let base = "";
let server;

// ---------- fake IdP (minimo, come in test/oidc-service.test.js) ----------
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
idp.get("/jwks", (req, res) => res.json({ keys: [pubJwk] }));
idp.post("/token", async (req, res) => {
  const entry = codes.get(req.body.code);
  if (!entry) return res.status(400).json({ error: "invalid_grant" });
  const challenge = b64u(crypto.createHash("sha256").update(String(req.body.code_verifier || "")).digest());
  if (challenge !== entry.challenge) return res.status(400).json({ error: "invalid_grant" });
  if (req.body.client_secret !== "s3cret") return res.status(401).json({ error: "invalid_client" });
  if (req.body.redirect_uri !== oidc.redirectUri()) return res.status(400).json({ error: "invalid_redirect" });
  const idToken = await new jose.SignJWT(entry.claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(keyA.privateKey);
  res.json({ id_token: idToken, access_token: "x", token_type: "Bearer" });
});

function claimsFor(email, nonce) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: base, aud: "client-1", sub: "idp-sub-" + rand(), email, email_verified: true, nonce, iat: now, exp: now + 300 };
}

// ---------- helper ----------
async function mkUser(siteId, role = "admin") {
  const u = await createTestUser(siteId, role);
  const email = `u-${rand()}@idp-${rand()}.example.com`;
  await query("UPDATE users SET email = $1 WHERE id = $2", [email, u.id]);
  return { ...u, email };
}
async function mkProvider(extra = {}) {
  return oidc.createProvider({ slug: "idp-" + rand(), name: "IdP", issuer: base, client_id: "client-1", client_secret: "s3cret", ...extra });
}
// Avvia il flusso via router (GET /start), registra il code nel fake IdP.
async function startFlow(app, provider, email, mutate) {
  const r = await httpReq(app.baseUrl, `/auth/oidc/${provider.id}/start`);
  assert.equal(r.status, 302);
  const authUrl = new URL(r.headers.location);
  const state = authUrl.searchParams.get("state");
  const set = (r.headers["set-cookie"] || []).find((c) => c.startsWith("oidc_state="));
  const code = crypto.randomBytes(16).toString("hex");
  const claims = claimsFor(email, authUrl.searchParams.get("nonce"));
  if (mutate) mutate(claims);
  codes.set(code, { challenge: authUrl.searchParams.get("code_challenge"), claims });
  return { code, state, cookie: set ? set.split(";")[0] : null };
}
const callback = (app, code, state, cookie) =>
  httpReq(app.baseUrl, `/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { headers: cookie ? { Cookie: cookie } : {} });
const hasTokenCookie = (r) => (r.headers["set-cookie"] || []).some((c) => c.startsWith("token="));

describe("auth oidc router", () => {
  let site, siteB, admin, adminB, collab, app, domain;
  let prov, provTrust, provDisabled, provB;

  before(async () => {
    server = idp.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
    site = await createTestSite("SSO A");
    siteB = await createTestSite("SSO B");
    admin = await mkUser(site.id, "admin");
    adminB = await mkUser(siteB.id, "admin");
    collab = await mkUser(site.id, "collaboratore");
    domain = await addDomain(site.id);
    prov = await mkProvider({ site_id: site.id });
    provTrust = await mkProvider({ site_id: site.id, trust_idp_mfa: true });
    provDisabled = await mkProvider({ site_id: site.id, enabled: false });
    provB = await mkProvider({ site_id: siteB.id });
    app = await startApp({ views: true, routers: [authOidcRouter] });
  });

  after(async () => {
    app.close();
    server.close();
    await closeDb();
  });

  test("start redirects to the IdP with PKCE and sets httpOnly state cookie", async () => {
    const r = await httpReq(app.baseUrl, `/auth/oidc/${prov.id}/start`);
    assert.equal(r.status, 302);
    assert.ok(r.headers.location.startsWith(base + "/authorize"));
    assert.ok(r.headers.location.includes("code_challenge_method=S256"));
    assert.ok(/[?&]state=/.test(r.headers.location));
    const set = (r.headers["set-cookie"] || []).find((c) => c.startsWith("oidc_state="));
    assert.ok(set, "oidc_state cookie missing");
    assert.match(set, /HttpOnly/i);
  });

  test("callback with the matching state cookie logs in and redirects to dashboard", async () => {
    const user = await mkUser(site.id, "admin");
    const f = await startFlow(app, prov, user.email);
    const r = await callback(app, f.code, f.state, f.cookie);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/admin/dashboard");
    assert.ok(hasTokenCookie(r), "session cookie missing");
  });

  test("callback without the state cookie is rejected", async () => {
    const user = await mkUser(site.id, "admin");
    const f = await startFlow(app, prov, user.email);
    const r = await callback(app, f.code, f.state, null);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/login?error=state_mismatch");
    assert.equal(hasTokenCookie(r), false);
  });

  test("unknown local email is rejected with no_local_user", async () => {
    const f = await startFlow(app, prov, `nobody-${rand()}@idp-${rand()}.example.com`);
    const r = await callback(app, f.code, f.state, f.cookie);
    assert.equal(r.headers.location, "/login?error=no_local_user");
    assert.equal(hasTokenCookie(r), false);
  });

  test("user with TOTP and trust_idp_mfa=false gets an MFA ticket, no session", async () => {
    const user = await mkUser(site.id, "admin");
    await query("INSERT INTO user_mfa (user_id, totp_secret_enc, totp_enabled) VALUES ($1, $2, true)", [user.id, "v1:test"]);
    const f = await startFlow(app, prov, user.email);
    const r = await callback(app, f.code, f.state, f.cookie);
    assert.equal(r.status, 302);
    assert.ok(r.headers.location.startsWith("/login/verify?ticket="), r.headers.location);
    assert.equal(hasTokenCookie(r), false);
  });

  test("user with TOTP and trust_idp_mfa=true gets a session cookie", async () => {
    const user = await mkUser(site.id, "admin");
    await query("INSERT INTO user_mfa (user_id, totp_secret_enc, totp_enabled) VALUES ($1, $2, true)", [user.id, "v1:test"]);
    const f = await startFlow(app, provTrust, user.email);
    const r = await callback(app, f.code, f.state, f.cookie);
    assert.equal(r.headers.location, "/admin/dashboard");
    assert.ok(hasTokenCookie(r), "session cookie missing");
  });

  test("error=access_denied from the IdP redirects to oidc_failed", async () => {
    const r = await httpReq(app.baseUrl, "/auth/oidc/callback?error=access_denied&state=x");
    assert.equal(r.headers.location, "/login?error=oidc_failed");
  });

  test("public providers list shows enabled providers of the site only, no issuer or secrets", async () => {
    const r = await httpReq(app.baseUrl, "/auth/oidc/providers", { host: domain });
    assert.equal(r.status, 200);
    const slugs = r.json().providers.map((p) => p.slug);
    assert.ok(slugs.includes(prov.slug));
    assert.ok(!slugs.includes(provDisabled.slug));
    assert.ok(!slugs.includes(provB.slug));
    assert.ok(!r.text.includes("issuer"));
    assert.ok(!r.text.includes("client_secret"));
    assert.ok(!r.text.includes("s3cret"));
  });

  test("admin of site A cannot create a global provider (403)", async () => {
    const r = await httpReq(app.baseUrl, "/admin/api/oidc-providers", {
      method: "POST",
      headers: { Cookie: await sessionCookie(admin.id) },
      body: { name: "G", slug: "g-" + rand(), issuer: base, client_id: "client-1", client_secret: "s3cret", site_id: null },
    });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, "forbidden");
  });

  test("created provider is forced to site A, no secrets in JSON, admin can delete it", async () => {
    const ck = await sessionCookie(admin.id);
    const r = await httpReq(app.baseUrl, "/admin/api/oidc-providers", {
      method: "POST",
      headers: { Cookie: ck },
      body: { name: "New", slug: "new-" + rand(), issuer: base, client_id: "client-1", client_secret: "s3cret", site_id: siteB.id },
    });
    assert.equal(r.status, 201);
    const p = r.json().provider;
    assert.equal(p.site_id, site.id);
    assert.ok(!r.text.includes("client_secret"));
    assert.ok(!r.text.includes("s3cret"));
    const row = (await query("SELECT site_id FROM oidc_providers WHERE id = $1", [p.id])).rows[0];
    assert.equal(row.site_id, site.id);
    const d = await httpReq(app.baseUrl, `/admin/api/oidc-providers/${p.id}`, { method: "DELETE", headers: { Cookie: ck } });
    assert.equal(d.status, 200);
    assert.equal(d.json().ok, true);
  });

  test("admin of site A can edit own provider; body site_id is ignored", async () => {
    const r = await httpReq(app.baseUrl, `/admin/api/oidc-providers/${prov.id}`, {
      method: "PUT",
      headers: { Cookie: await sessionCookie(admin.id) },
      body: { name: "Renamed", slug: prov.slug, issuer: base, client_id: "client-1", site_id: siteB.id },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json().provider.site_id, site.id);
    assert.equal(r.json().provider.name, "Renamed");
    assert.ok(!r.text.includes("client_secret"));
  });

  test("admin of site A cannot edit or delete a provider of site B (404)", async () => {
    const ck = await sessionCookie(admin.id);
    const put = await httpReq(app.baseUrl, `/admin/api/oidc-providers/${provB.id}`, {
      method: "PUT",
      headers: { Cookie: ck },
      body: { name: "hacked", slug: provB.slug, issuer: base, client_id: "client-1" },
    });
    assert.equal(put.status, 404);
    const del = await httpReq(app.baseUrl, `/admin/api/oidc-providers/${provB.id}`, { method: "DELETE", headers: { Cookie: ck } });
    assert.equal(del.status, 404);
    const row = (await query("SELECT name FROM oidc_providers WHERE id = $1", [provB.id])).rows[0];
    assert.equal(row.name, "IdP");
  });

  test("collaboratore gets 403 on the provider admin API", async () => {
    const r = await httpReq(app.baseUrl, "/admin/api/oidc-providers", { headers: { Cookie: await sessionCookie(collab.id) } });
    assert.equal(r.status, 403);
  });

  test("agent API token gets 403 session_required", async () => {
    const tok = await apiToken(admin.id);
    const r = await httpReq(app.baseUrl, "/admin/api/oidc-providers", { headers: { Authorization: `Bearer ${tok}` } });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, "session_required");
  });
});
