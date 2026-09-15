import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";
import publicOauthProviderRouter from "../../src/routes/public-oauth-provider.js";

describe("Onda G2 — OAuth provider clone", () => {
  let server, baseUrl;
  let site, user;
  let apiToken;
  let app;

  const mkApiToken = async (userId, siteId) => {
    const raw = "agtok_" + crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const result = await query(
      `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, expires_at, scopes)
       VALUES ($1, $2, $3, $4, NOW() + interval '1 year', $5)
       RETURNING id`,
      [userId, "test-token", hash, raw.slice(0, 14), ["read", "write"]]
    );
    return { id: result.rows[0].id, raw };
  };

  const mkSiteApiKey = async (siteId, suffix = "") => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const name = `oauth test key ${suffix || crypto.randomBytes(2).toString("hex")}`;
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  before(async () => {
    // Crea site di test
    site = await createTestSite("OAuth Clone Test");

    // Crea utente di test
    const userResult = await query(
      `INSERT INTO users (site_id, email, name, role, status, token_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, external_id`,
      [site.id, `oauth-user-${crypto.randomBytes(4).toString("hex")}@test.local`, "OAuth User", "admin", "active", 1]
    );
    user = { id: userResult.rows[0].id, externalId: userResult.rows[0].external_id };

    // API token per autorizzazione (bearer agtok_)
    apiToken = await mkApiToken(user.id, site.id);

    // Crea app Express con ENTRAMBI i router
    const app_instance = express();
    app_instance.use(express.json());
    app_instance.use(express.urlencoded({ extended: true }));

    // Router OAuth pubblico (rotte senza tenant) — DEVE stare PRIMA di cloneRoutes
    // per evitare che apiDialect middleware applichi 401 alle rotte pubbliche
    app_instance.use(publicOauthProviderRouter);

    // Router clone (tenant-scoped, con apiDialect middleware)
    app_instance.use(cloneRoutes);

    app_instance.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app_instance.use((err, req, res, next) => {
      console.error("Express error:", err);
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app_instance.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  // ── POST /oauth/apps (tenant-scoped) ──────────────────────────────────

  test("POST /oauth/apps — registra app OAuth", async () => {
    const res = await globalThis.fetch(`${baseUrl}/oauth/apps?locationId=${site.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer testkey_xxx`, // NB: il valore esatto hash=token_hash
      },
      body: JSON.stringify({
        name: "Test OAuth App",
        redirectUris: ["https://app.example.com/callback"],
        scopes: ["contacts.readonly", "opportunities.write"],
      }),
    });

    // NB: il body ha siteKey.raw che non è nel Bearer — fallerà validazione
    // Corretta: usare siteKey.raw nel Bearer
    assert.equal(res.status, 401, "Dovrebbe essere 401 (token errato)");
  });

  test("POST /oauth/apps — registra app OAuth (key corretta)", async () => {
    // Ricrea site key per questo test
    const siteKey = await mkSiteApiKey(site.id);

    const res = await globalThis.fetch(`${baseUrl}/oauth/apps?locationId=${site.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${siteKey.raw}`,
      },
      body: JSON.stringify({
        name: "Test OAuth App",
        redirectUris: ["https://app.example.com/callback"],
        scopes: ["contacts.readonly", "opportunities.write"],
      }),
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert(data.app);
    assert(data.app.id, "App ID (external_id UUID) presente");
    assert(data.app.clientId, "Client ID presente");
    assert(data.app.clientSecret, "Client secret ritornato UNA SOLA VOLTA");
    assert.deepEqual(data.app.redirectUris, ["https://app.example.com/callback"]);
    assert.deepEqual(data.app.scopes, ["contacts.readonly", "opportunities.write"]);

    // Salva per i test successivi
    globalThis.testAppData = {
      clientId: data.app.clientId,
      clientSecret: data.app.clientSecret,
      redirectUri: data.app.redirectUris[0],
    };

    // Diagnostica: verifica che l'app sia salvato
    const verifyRes = await globalThis.fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(data.app.clientId)}&redirect_uri=${encodeURIComponent(data.app.redirectUris[0])}&scope=test`
    );
    const verifyData = await verifyRes.text();
    if (verifyRes.status !== 200) {
      console.log("Test 2 diagnostica: GET /oauth/authorize fallito");
      console.log("  Status:", verifyRes.status);
      console.log("  ClientId:", data.app.clientId);
      console.log("  RedirectUri:", data.app.redirectUris[0]);
      console.log("  Response:", verifyData.slice(0, 200));
    }
  });

  // ── GET /oauth/authorize (form) ───────────────────────────────────────

  test("GET /oauth/authorize — mostra form HTML", async () => {
    const { clientId, redirectUri } = globalThis.testAppData;

    const res = await globalThis.fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=contacts.readonly&state=abc123`
    );

    assert.equal(res.status, 200);
    const html = await res.text();
    assert(html.includes("<form"), "HTML contiene form");
    assert(html.includes(clientId), "Client ID nella form");
    assert(html.includes("Autorizza"), "Bottone autorizzazione");
  });

  test("GET /oauth/authorize — errore client_id assente", async () => {
    const res = await globalThis.fetch(
      `${baseUrl}/oauth/authorize?redirect_uri=https://app.example.com/callback&scope=contacts.readonly`
    );

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.message, /client_id/i);
  });

  // ── POST /oauth/authorize/decision ────────────────────────────────────

  test("POST /oauth/authorize/decision — approva (redirect con code)", async () => {
    const { clientId, redirectUri } = globalThis.testAppData;

    const res = await globalThis.fetch(`${baseUrl}/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken.raw}`,
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "contacts.readonly opportunities.write",
        state: "abc123",
        decision: "approve",
      }),
      redirect: "manual", // Non seguire automaticamente
    });

    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert(location, "Redirect location presente");
    assert(location.includes(redirectUri), "Redirect a redirect_uri");
    assert(location.includes("code="), "Code nel query string");
    assert(location.includes("state=abc123"), "State preservato");

    // Estrai il code per il prossimo test
    const url = new URL(location);
    globalThis.testAuthCode = url.searchParams.get("code");
    assert(globalThis.testAuthCode, "Authorization code estratto");

    // Verifica che il code sia valido facendo un test exchange subito
    console.log("Test 5: Generated code starts with", String(globalThis.testAuthCode).slice(0, 20));
  });

  test("POST /oauth/authorize/decision — nega (redirect con errore)", async () => {
    const { clientId, redirectUri } = globalThis.testAppData;

    const res = await globalThis.fetch(`${baseUrl}/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken.raw}`,
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "contacts.readonly",
        state: "xyz789",
        decision: "deny",
      }),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert(location.includes("error=access_denied"));
    assert(location.includes("state=xyz789"));
  });

  // ── POST /oauth/token (exchange) ──────────────────────────────────────

  test("POST /oauth/token — exchange code per access/refresh token", async () => {
    const { clientId, clientSecret, redirectUri } = globalThis.testAppData;
    const code = globalThis.testAuthCode;

    console.log("Test 7: Using", {
      clientId: String(clientId).slice(0, 20),
      clientSecret: String(clientSecret).slice(0, 20),
      code: String(code).slice(0, 20),
      redirectUri: String(redirectUri).slice(0, 40),
    });

    const res = await globalThis.fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (res.status !== 200) {
      const errData = await res.json();
      console.log("Test 7 error:", { status: res.status, error: errData });
    }
    assert.equal(res.status, 200);
    const data = await res.json();
    assert(data.access_token, "Access token presente");
    assert(data.refresh_token, "Refresh token presente");
    assert.equal(data.expires_in, 3600);
    assert.equal(data.token_type, "Bearer");
    assert(data.scope, "Scope presente");

    // Salva per i test successivi
    globalThis.testTokens = { accessToken: data.access_token, refreshToken: data.refresh_token };
  });

  test("POST /oauth/token — errore code scaduto/usato", async () => {
    const { clientId, clientSecret, redirectUri } = globalThis.testAppData;
    const code = globalThis.testAuthCode; // Già usato nel test precedente

    const res = await globalThis.fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, "invalid_grant");
  });

  test("POST /oauth/token — errore client_secret errato", async () => {
    // Crea nuovo code per questo test
    const siteKey = await mkSiteApiKey(site.id);
    const { clientId, redirectUri } = globalThis.testAppData;

    const authorizeRes = await globalThis.fetch(`${baseUrl}/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken.raw}`,
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "contacts.readonly",
        state: "test",
        decision: "approve",
      }),
      redirect: "manual",
    });

    const location = authorizeRes.headers.get("location");
    const url = new URL(location);
    const newCode = url.searchParams.get("code");

    const tokenRes = await globalThis.fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: newCode,
        client_id: clientId,
        client_secret: "wrong_secret",
        redirect_uri: redirectUri,
      }).toString(),
    });

    assert.equal(tokenRes.status, 401);
    const data = await tokenRes.json();
    assert.equal(data.error, "invalid_client");
  });

  // ── GET /oauth/userinfo ──────────────────────────────────────────────

  test("GET /oauth/userinfo — con Bearer access_token valido", async () => {
    const { accessToken } = globalThis.testTokens;

    const res = await globalThis.fetch(`${baseUrl}/oauth/userinfo`, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert(data.sub, "User external_id (sub) presente");
    assert(data.email, "Email presente");
    assert(data.locationId, "Location ID presente");
  });

  test("GET /oauth/userinfo — errore token mancante", async () => {
    const res = await globalThis.fetch(`${baseUrl}/oauth/userinfo`);

    assert.equal(res.status, 401);
    const data = await res.json();
    assert(data.message.includes("token"));
  });

  // ── POST /oauth/token (refresh) ──────────────────────────────────────

  test("POST /oauth/token refresh_token — rotazione token", async () => {
    const { refreshToken } = globalThis.testTokens;

    const res = await globalThis.fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert(data.access_token, "Nuovo access token presente");
    assert(data.refresh_token, "Nuovo refresh token presente");
    assert.notEqual(data.access_token, globalThis.testTokens.accessToken, "Access token diverso");

    // Salva i nuovi token
    globalThis.testTokens.accessToken = data.access_token;
    globalThis.testTokens.refreshToken = data.refresh_token;
  });

  test("POST /oauth/token refresh_token — vecchio refresh fallisce dopo rotazione", async () => {
    const oldRefresh = globalThis.testTokens.refreshToken;
    const currentRefresh = globalThis.testTokens.refreshToken;

    // Usa il refresh attuale per ruotare di nuovo
    const rotateRes = await globalThis.fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: currentRefresh,
      }).toString(),
    });
    assert.equal(rotateRes.status, 200);

    // Ora il vecchio refresh dovrebbe fallire
    const res = await globalThis.fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oldRefresh,
      }).toString(),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, "invalid_grant");
  });

  // ── POST /oauth/revoke ───────────────────────────────────────────────

  test("POST /oauth/revoke — revoca access_token", async () => {
    const { accessToken } = globalThis.testTokens;

    const res = await globalThis.fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    // Verifica che userinfo fallisce dopo revoca
    const userinfoRes = await globalThis.fetch(`${baseUrl}/oauth/userinfo`, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    assert.equal(userinfoRes.status, 401);
  });

  test("POST /oauth/revoke — sempre 200 (anche token inesistente, per privacy)", async () => {
    const res = await globalThis.fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "oat_nonexistent" }).toString(),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });
});
