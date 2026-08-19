import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerOauthRoutes } from "../src/routes/agent-oauth.js";
import { publicOauthRouter } from "../src/routes/public-oauth.js";
import { buildState, verifyState } from "../src/services/oauth.js";

// Feature 36 — OAuth Google (flusso Authorization Code per Gmail/Calendar/
// Drive). Come prescritto NON si importa agentRouter: il modulo agent è
// montato su un router locale con requireAuth + requireAgent, quello
// pubblico su app.use() senza auth. Le chiamate reali a Google avvengono
// solo con credenziali configurate; senza credenziali/rete il servizio
// ritorna {error} (mai 500).
describe("feature 36: oauth google", () => {
  let site, user, token, server, baseUrl;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const json = (extra = {}) => ({ ...auth(), "Content-Type": "application/json", ...extra });
  const appsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/oauth-apps${extra}`;
  const oauthUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/oauth${extra}`;

  const REDIRECT = "https://app.example.test/oauth/callback/google";

  before(async () => {
    site = await createTestSite("CRM OAuth Test");
    user = await createTestUser(site.id, "admin");
    token = (await createApiToken(user.id, "oauth test", 30)).token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerOauthRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use(publicOauthRouter); // modulo pubblico SENZA auth

    // Error handler esplicito: un 500 qui è un fallimento del test.
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  // ── (a) CRUD app OAuth ────────────────────────────────────────────────

  test("CRUD app OAuth (create/list/update/delete, validazioni)", async () => {
    const res = await fetch(appsUrl(), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({
        client_id: "test-client",
        client_secret: "test-secret",
        redirect_uri: REDIRECT,
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      }),
    });
    assert.equal(res.status, 200);
    const appRow = (await res.json()).app;
    assert.ok(appRow.id);
    assert.equal(appRow.client_id, "test-client");
    assert.equal(appRow.provider, "google");
    assert.deepEqual(appRow.scopes, ["https://www.googleapis.com/auth/gmail.modify"]);
    assert.equal(appRow.enabled, true);

    // Lista.
    const list = await fetch(appsUrl(), { headers: auth() });
    assert.equal(list.status, 200);
    const { apps } = await list.json();
    assert.ok(Array.isArray(apps) && apps.some((a) => a.id === appRow.id));

    // Update (rename + disattiva).
    const upd = await fetch(appsUrl(`/${appRow.id}`), {
      method: "PUT",
      headers: json(),
      body: JSON.stringify({ client_id: "test-client-2", enabled: false }),
    });
    assert.equal(upd.status, 200);
    const updated = (await upd.json()).app;
    assert.equal(updated.client_id, "test-client-2");
    assert.equal(updated.enabled, false);

    // Validazione: redirect_uri non http/https → 400.
    const bad = await fetch(appsUrl(), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ redirect_uri: "ftp://nope" }),
    });
    assert.equal(bad.status, 400);

    // Update di un'app inesistente → 404.
    const missing = await fetch(appsUrl("/999999"), {
      method: "PUT",
      headers: json(),
      body: JSON.stringify({ client_id: "x" }),
    });
    assert.equal(missing.status, 404);

    // Delete.
    const del = await fetch(appsUrl(`/${appRow.id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, true);
    const after = await fetch(appsUrl(), { headers: auth() });
    assert.ok(!(await after.json()).apps.some((a) => a.id === appRow.id));
  });

  // ── (b) getAuthUrl → URL Google completo ──────────────────────────────

  test("getAuthUrl genera URL Google con client_id, redirect, offline, state", async () => {
    const created = await fetch(appsUrl(), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ client_id: "test-client", redirect_uri: REDIRECT }),
    });
    assert.equal(created.status, 200);
    const appRow = (await created.json()).app;

    const res = await fetch(oauthUrl("/auth-url"), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ app_id: appRow.id }),
    });
    assert.equal(res.status, 200);
    const { url, state } = await res.json();

    assert.ok(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), url);
    assert.ok(url.includes("client_id=test-client"), "client_id mancante");
    assert.ok(url.includes("redirect_uri="), "redirect_uri mancante");
    assert.ok(url.includes("response_type=code"), "response_type mancante");
    assert.ok(url.includes("access_type=offline"), "access_type mancante");
    assert.ok(url.includes("prompt=consent"), "prompt mancante");
    assert.ok(url.includes("scope="), "scope mancante");
    assert.ok(state, "state mancante");
    // Lo state codifica siteId:appId:rand:firma per il callback pubblico.
    assert.ok(state.startsWith(`${site.id}:${appRow.id}:`), `state inatteso: ${state}`);
    // La firma HMAC è presente (4 parti) e verifyState lo accetta.
    assert.equal(state.split(":").length, 4, `state non firmato: ${state}`);
    assert.deepEqual(verifyState(state), { siteId: site.id, appId: appRow.id });
  });

  // ── (c) getAuthUrl senza app → errore ────────────────────────────────

  test("getAuthUrl con app inesistente → 400 {error}", async () => {
    const res = await fetch(oauthUrl("/auth-url"), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ app_id: 999999 }),
    });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });

  // ── (d) exchangeCode con app inesistente → errore ─────────────────────

  test("exchangeCode con app inesistente → {error}, mai 500", async () => {
    const res = await fetch(oauthUrl("/exchange"), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ app_id: 999999, code: "x" }),
    });
    assert.ok(res.status < 500, `status inatteso: ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, `atteso {error}, ricevuto: ${JSON.stringify(body)}`);
  });

  // ── (e) exchangeCode con app presente ma fetch verso Google fallisce ──

  test("exchangeCode con credenziali finte → fallimento pulito (mai 500)", async () => {
    const created = await fetch(appsUrl(), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({
        client_id: "test-client",
        client_secret: "test-secret",
        redirect_uri: REDIRECT,
      }),
    });
    assert.equal(created.status, 200);
    const appRow = (await created.json()).app;

    // code finto 'bad': se il container ha rete, Google risponde 400; se non
    // ce l'ha, fetch lancia. In ENTRAMBI i casi il servizio deve ritornare
    // 200 HTTP con {error} (o al più una connessione), MAI un 500.
    const res = await fetch(oauthUrl("/exchange"), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ app_id: appRow.id, code: "bad" }),
    });
    assert.equal(res.status, 200, `status inatteso: ${res.status}`);
    const body = await res.json();
    assert.ok(
      body.error || body.connection,
      `atteso {error} o {connection}, ricevuto: ${JSON.stringify(body)}`
    );
    if (body.error) {
      assert.match(body.error, /Scambio codice fallito/);
    }
    // Nessuna connessione attiva deve essere stata creata dal fallimento.
    const conns = await fetch(oauthUrl("/connections"), { headers: auth() });
    const { connections } = await conns.json();
    assert.ok(!connections.some((c) => c.app_id === appRow.id && c.active));
  });

  // ── (f) listConnections ───────────────────────────────────────────────

  test("listConnections ritorna array (vuoto all'inizio)", async () => {
    const res = await fetch(oauthUrl("/connections"), { headers: auth() });
    assert.equal(res.status, 200);
    const { connections } = await res.json();
    assert.ok(Array.isArray(connections));
  });

  // ── (g) disconnect ────────────────────────────────────────────────────

  test("disconnect senza connessione → ok (idempotente)", async () => {
    const res = await fetch(oauthUrl("/disconnect"), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ app_id: 999999 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.disconnected, false);
  });

  // ── (h) refreshToken senza refresh_token → errore ─────────────────────

  test("refreshToken senza refresh_token → {error:'Nessun refresh token'}", async () => {
    const created = await fetch(appsUrl(), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ client_id: "test-client", redirect_uri: REDIRECT }),
    });
    assert.equal(created.status, 200);
    const appRow = (await created.json()).app;

    // Connessione attiva SENZA refresh_token (access_token in chiaro finto).
    const ins = await query(
      `INSERT INTO oauth_connections (site_id, app_id, provider, account_email, access_token, refresh_token, active)
       VALUES ($1, $2, 'google', 'u@example.test', 'tok-finto', '', true) RETURNING id`,
      [site.id, appRow.id]
    );
    const connId = ins.rows[0].id;

    const res = await fetch(oauthUrl("/refresh"), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ connection_id: connId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, "Nessun refresh token");
  });

  // ── Callback pubblico ─────────────────────────────────────────────────

  test("callback pubblico con state invalido → 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/callback/google?code=abc&state=notvalid`);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });

  test("callback con state non firmato (3 parti) → 400", async () => {
    // Un attaccante che conosce siteId+appId può forgiare `1:2:hex` ma NON
    // la firma HMAC: lo state senza firma deve essere rifiutato.
    const res = await fetch(`${baseUrl}/oauth/callback/google?code=abc&state=${site.id}:2:deadbeef`);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });

  test("callback con state contraffatto (firma alterata) → 400", async () => {
    const good = buildState(site.id, 2);
    const forged = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const res = await fetch(`${baseUrl}/oauth/callback/google?code=abc&state=${forged}`);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });

  test("callback con state firmato valido supera il check (mai 400)", async () => {
    // State firmato da buildState: la verifica passa, poi exchangeCode
    // fallisce verso Google (code finto) → redirect 302 a /login, MAI 400.
    // redirect:"manual" evita che fetch segua il redirect a /login
    // (che nel server di test non esiste → altrimenti 404 "Cannot GET /login").
    const good = buildState(site.id, 2);
    const res = await fetch(`${baseUrl}/oauth/callback/google?code=abc&state=${good}`, {
      redirect: "manual",
    });
    assert.equal(res.status, 302, `atteso redirect 302, ricevuto ${res.status}`);
    assert.equal(res.headers.get("location"), "/login?error=oauth");
  });

  test("verifyState rifiuta state con firma di un raw diverso", () => {
    const good = buildState(site.id, 2);
    const parts = good.split(":");
    // Stessa firma ma raw con siteId diverso → verifica fallita.
    const swapped = `999999:${parts[1]}:${parts[2]}:${parts[3]}`;
    assert.equal(verifyState(swapped), null);
  });

  test("callback pubblico con provider non supportato → 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/callback/microsoft?code=abc&state=1:2:x`);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });
});
