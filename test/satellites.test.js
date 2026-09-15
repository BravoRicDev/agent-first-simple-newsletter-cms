import crypto from "crypto";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { normalizeOrigin, validateRedirectUri, createSatellite } from "../src/services/satellites.js";
import agentRouter from "../src/routes/agent.js";
import authRouter from "../src/routes/auth.js";

describe("registro satelliti SSO: validazione redirect_uri + CRUD", () => {
  let site, superadminToken, adminToken, server, baseUrl;
  const unique = () => crypto.randomBytes(4).toString("hex");

  before(async () => {
    site = await createTestSite("Satellites Test");
    const superadmin = await createTestUser(site.id, "superadmin");
    const admin = await createTestUser(site.id, "admin");
    superadminToken = (await createApiToken(superadmin.id, "sat super", 30, ["read", "write"])).token;
    adminToken = (await createApiToken(admin.id, "sat admin", 30, ["read", "write"])).token;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
      res.locals.t = (k) => k;
      res.locals.lang = "it";
      res.locals.app = { name: "CMS" };
      next();
    });
    app.set("view engine", "ejs");
    app.set("views", new URL("../views", import.meta.url).pathname);
    app.use(agentRouter);
    app.use(authRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });
  const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  test("normalizeOrigin canonicalizza host case e porte default", async () => {
    assert.equal(normalizeOrigin("HTTPS://SALES.Example.com:443"), "https://sales.example.com");
    assert.equal(normalizeOrigin("http://x.example.test:80/path"), "http://x.example.test");
    assert.equal(normalizeOrigin("http://x.example.test:8080"), "http://x.example.test:8080");
    assert.equal(normalizeOrigin("not a url"), null);
    assert.equal(normalizeOrigin("ftp://x.example.test"), null);
  });

  test("validateRedirectUri accetta un origin registrato e attivo, con path+query", async () => {
    const s = await createSatellite({ name: "test-" + unique(), origin: `https://mod-${unique()}.example.test`, enabled: true });
    const out = await validateRedirectUri(`${s.origin}/dashboard?tab=1`);
    assert.equal(out, `${s.origin}/dashboard?tab=1`);
  });

  test("validateRedirectUri rifiuta origin non registrato o disabilitato", async () => {
    assert.equal(await validateRedirectUri(`https://sconosciuto-${unique()}.example.test/x`), null);
    const s = await createSatellite({ name: "off-" + unique(), origin: `https://off-${unique()}.example.test`, enabled: false });
    assert.equal(await validateRedirectUri(`${s.origin}/dashboard`), null);
    // Fail-closed su input spazzatura
    assert.equal(await validateRedirectUri("javascript:alert(1)"), null);
    assert.equal(await validateRedirectUri(undefined), null);
  });

  test("CRUD agent API: lista, crea, aggiorna, elimina (superadmin)", async () => {
    const list1 = await fetch(`${baseUrl}/api/agent/satellites`, { headers: auth(superadminToken) });
    assert.equal(list1.status, 200);
    const before = (await list1.json()).satellites.length;

    const created = await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({ name: "modulo-" + unique(), origin: `https://app-${unique()}.example.test` }),
    });
    assert.equal(created.status, 201);
    const sat = (await created.json()).satellite;

    const updated = await fetch(`${baseUrl}/api/agent/satellites/${sat.id}`, {
      method: "PUT",
      headers: auth(superadminToken),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).satellite.enabled, false);

    const del = await fetch(`${baseUrl}/api/agent/satellites/${sat.id}`, {
      method: "DELETE",
      headers: auth(superadminToken),
    });
    assert.equal(del.status, 200);

    const list2 = await fetch(`${baseUrl}/api/agent/satellites`, { headers: auth(superadminToken) });
    assert.equal((await list2.json()).satellites.length, before);
  });

  test("creazione con origin malformata → 400; ruolo non superadmin → 403", async () => {
    const bad = await fetch(`${baseUrl}/api/agent/satellites`, {
      method: "POST",
      headers: auth(superadminToken),
      body: JSON.stringify({ name: "bad", origin: "per-niente-url" }),
    });
    assert.equal(bad.status, 400);

    const forbidden = await fetch(`${baseUrl}/api/agent/satellites`, { headers: auth(adminToken) });
    assert.equal(forbidden.status, 403);
  });

  test("flusso verify con redirect_uri valida → redirect_to; non valida → null", async () => {
    const user = (await query(
      "SELECT id FROM users WHERE site_id = $1 AND status = 'active' ORDER BY id LIMIT 1", [site.id]
    )).rows[0];
    const sat = await createSatellite({ name: "flow-" + unique(), origin: `https://flow-${unique()}.example.test`, enabled: true });
    const token = crypto.randomBytes(48).toString("hex");
    await query(
      "INSERT INTO magic_links (user_id, token, otp, expires_at) VALUES ($1,$2,$3,$4)",
      [user.id, token, "123456", new Date(Date.now() + 600000)]
    );

    const ok = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, otp: "123456", redirect_uri: `${sat.origin}/dashboard?x=1` }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.user?.id);
    assert.equal(body.redirect_to, `${sat.origin}/dashboard?x=1`);

    // Nuovo magic link per il secondo tentativo (il primo è monouso)
    const token2 = crypto.randomBytes(48).toString("hex");
    await query(
      "INSERT INTO magic_links (user_id, token, otp, expires_at) VALUES ($1,$2,$3,$4)",
      [user.id, token2, "123456", new Date(Date.now() + 600000)]
    );
    const ko = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token2, otp: "123456", redirect_uri: "https://attaccante.example.test/steal" }),
    });
    assert.equal(ko.status, 200);
    assert.equal((await ko.json()).redirect_to, null);
  });

  test("GET /login propaga redirect_uri nel form nascosto", async () => {
    const sat = await createSatellite({ name: "page-" + unique(), origin: `https://page-${unique()}.example.test`, enabled: true });
    const res = await fetch(`${baseUrl}/login?redirect_uri=${encodeURIComponent(sat.origin + "/dashboard")}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(sat.origin + "/dashboard"));
  });
});
