import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import publicOauthRouter from "../src/routes/public-oauth-provider.js";
import { load } from "cheerio";

// Test XSS per GET /oauth/authorize (src/routes/public-oauth-provider.js).
//
// Strategia: invece di asserire sulle singole entità (fragili: l'escape
// produce testo innocuo che contiene ancora lettere come "onerror"), si
// verifica la PROPRIETA' che conta:
//   1. nessun elemento iniettabile viene creato dal payload
//      (load(html)('script').length === 0, load(html)('img').length === 0,
//      nessun attributo on*)
//   2. round-trip fedele: cheerio decodifica le entità, quindi il value
//      dell'input hidden deve essere ESATTAMENTE il payload originale
//      (escape senza perdita, nessun dato corrotto dal filtro)
//   3. header Content-Security-Policy presente con il valore richiesto.
describe("OAuth XSS protection — GET /oauth/authorize", () => {
  let site, user, token, server, baseUrl;

  // Suffisso casuale: client_id è UNIQUE, righe residue farebbero fallire
  // la seconda esecuzione con 23505.
  const SUFFIX = crypto.randomUUID().slice(0, 8);

  const CLIENT_ID = `xss-client-${SUFFIX}`;
  const REDIRECT_URI = "https://app.example.test/cb";
  const SCOPE = "read";
  const NAME_PAYLOAD = "Evil <img src=x onerror=alert(1)> App";
  const SCOPES_PAYLOAD = ["read", "<script>alert('scope')</script>"];
  const REDIRECT_URI_PAYLOAD = 'https://app.example.test/cb?x="><script>alert(1)</script>';
  const CLIENT_ID_PAYLOAD = `evil"><img src=x onerror=alert(1)>-${SUFFIX}`;
  const STATE_PAYLOAD = '&quot;><script>alert(1)</script>';
  const SCOPE_PAYLOAD = 'read"><script>alert(9)</script>';

  const authorizeUrl = (params) => {
    const qs = new URLSearchParams({ response_type: "code", ...params }).toString();
    return `${baseUrl}/oauth/authorize?${qs}`;
  };

  // Nessun elemento iniettabile deve esistere nella pagina.
  const assertNoInjectedElement = (html) => {
    const $ = load(html);
    assert.equal($("script").length, 0, "trovato elemento <script> (XSS riuscita)");
    assert.equal($("img").length, 0, "trovato elemento <img> (XSS riuscita)");
    assert.equal($("iframe").length, 0, "trovato elemento <iframe>");
    assert.ok(!html.includes("<script"), "il markup contiene la stringa '<script'");
    assert.ok(!html.includes("<img"), "il markup contiene la stringa '<img'");
    assert.equal($("[onerror], [onload], [onclick], [onmouseover]").length, 0, "trovato handler inline on*");
  };

  before(async () => {
    site = await createTestSite("OAuth XSS Test");
    user = await createTestUser(site.id, "admin");
    token = (await createApiToken(user.id, "xss test", 30, ["read", "write"])).token;

    // App con name/scopes/redirect_uris malevoli.
    await query(
      `INSERT INTO oauth_provider_apps (site_id, client_id, client_secret_hash, name, redirect_uris, scopes, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [
        site.id,
        CLIENT_ID,
        "hash",
        NAME_PAYLOAD,
        JSON.stringify([REDIRECT_URI, REDIRECT_URI_PAYLOAD]),
        JSON.stringify(SCOPES_PAYLOAD),
      ]
    );

    // App con client_id malevolo.
    await query(
      `INSERT INTO oauth_provider_apps (site_id, client_id, client_secret_hash, name, redirect_uris, scopes, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [
        site.id,
        CLIENT_ID_PAYLOAD,
        "hash2",
        "App2",
        JSON.stringify([REDIRECT_URI]),
        JSON.stringify(["read"]),
      ]
    );

    const r = Router();
    r.use("/api/agent", requireAuth);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use(publicOauthRouter);

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
    // Pulizia: client_id è UNIQUE, le righe create devono sparire altrimenti
    // la seconda esecuzione fallisce con 23505.
    if (site?.id) {
      await query("DELETE FROM oauth_provider_apps WHERE site_id = $1", [site.id]);
    }
    await closeDb();
  });

  test("state con payload XSS: round-trip esatto, nessun elemento creato, CSP presente", async () => {
    const res = await fetch(authorizeUrl({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: STATE_PAYLOAD,
    }));
    assert.equal(res.status, 200);

    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "header Content-Security-Policy assente");
    assert.equal(
      csp,
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "CSP header diverso dal valore richiesto"
    );

    const html = await res.text();
    assertNoInjectedElement(html);

    // Round-trip: il value deve tornare IDENTICO al payload inviato.
    const $ = load(html);
    assert.equal($('input[name="state"]').val(), STATE_PAYLOAD, "state non preservato dall'escape");
  });

  test("app.name con <img onerror>: nessun elemento img, testo preservato", async () => {
    const res = await fetch(authorizeUrl({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: "normal",
    }));
    assert.equal(res.status, 200);
    const html = await res.text();

    assertNoInjectedElement(html);

    // Il payload deve comparire come TESTO, non come markup.
    const $ = load(html);
    assert.equal($("strong").first().text(), NAME_PAYLOAD, "app.name non preservato dall'escape");
  });

  test("app.scopes con <script>: nessun elemento script, testo preservato", async () => {
    const res = await fetch(authorizeUrl({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: "normal",
    }));
    assert.equal(res.status, 200);
    const html = await res.text();

    assertNoInjectedElement(html);

    const $ = load(html);
    const rendered = $(".scope-item").map((_, el) => $(el).text().trim()).get();
    assert.deepEqual(rendered, SCOPES_PAYLOAD.map((s) => `• ${s}`.trim()), "scope non preservati dall'escape");
  });

  test("scope della query con payload: round-trip esatto e nessun elemento script", async () => {
    const res = await fetch(authorizeUrl({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE_PAYLOAD,
      state: "normal",
    }));
    assert.equal(res.status, 200);
    const html = await res.text();

    assertNoInjectedElement(html);

    const $ = load(html);
    assert.equal($('input[name="scope"]').val(), SCOPE_PAYLOAD, "scope non preservato dall'escape");
  });

  test("client_id malevolo: round-trip esatto e nessun elemento img", async () => {
    const res = await fetch(authorizeUrl({
      client_id: CLIENT_ID_PAYLOAD,
      redirect_uri: REDIRECT_URI,
      scope: "read",
      state: "normal",
    }));
    assert.equal(res.status, 200);
    const html = await res.text();

    assertNoInjectedElement(html);

    const $ = load(html);
    assert.equal($('input[name="client_id"]').val(), CLIENT_ID_PAYLOAD, "client_id non preservato dall'escape");
  });

  test("redirect_uri con payload: round-trip esatto e nessun elemento script", async () => {
    const res = await fetch(authorizeUrl({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI_PAYLOAD,
      scope: SCOPE,
      state: "normal",
    }));
    assert.equal(res.status, 200);
    const html = await res.text();

    assertNoInjectedElement(html);

    const $ = load(html);
    assert.equal(
      $('input[name="redirect_uri"]').val(),
      REDIRECT_URI_PAYLOAD,
      "redirect_uri non preservato dall'escape"
    );
  });

  test("pagina di autorizzazione è no-JS (coerente con la CSP applicata)", async () => {
    const res = await fetch(authorizeUrl({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: "normal",
    }));
    assert.equal(res.status, 200);
    const html = await res.text();

    const $ = load(html);
    // Solo lo <style> inline consentito da style-src 'unsafe-inline'.
    assert.equal($("script").length, 0, "la pagina non deve contenere script");
    assert.equal($("style").length, 1, "la pagina deve avere il solo <style> inline");
    assert.ok(
      res.headers.get("content-security-policy").includes("style-src 'unsafe-inline'"),
      "CSP deve consentire lo <style> inline"
    );
    // Il form di decisione resta utilizzabile (action non interpolata).
    assert.equal($('form[action="/oauth/authorize/decision"]').length, 1, "form di decisione mancante");
  });
});