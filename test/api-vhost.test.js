import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { query } from "../src/db.js";
import config from "../src/config.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { apiHostMiddleware } from "../src/middleware/api-host.js";
import apiCloneRoutes from "../src/routes/api-clone/index.js";
import sitesRoutes from "../src/routes/sites.js";

// Fase 0 — vhost API dedicato (docs/API_CLONE_MASTER_PLAN.md §4.1): un
// hostname configurato come sites.api_domain devia l'INTERA richiesta al
// router clone root-level; ogni altro hostname resta invariato.
describe("Fase 0 — vhost API dedicato (api-host.js)", () => {
  let siteApi, siteNormal, server, baseUrl, apiKeyRaw, superadminToken;

  before(async () => {
    siteApi = await createTestSite("Vhost API Test");
    siteNormal = await createTestSite("Vhost Normal Test");

    const apiDomain = `apicrm-${crypto.randomBytes(4).toString("hex")}.example.test`;
    await query("UPDATE sites SET api_domain = $1 WHERE id = $2", [apiDomain, siteApi.id]);
    siteApi.api_domain = apiDomain;

    apiKeyRaw = "sitekey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(apiKeyRaw).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteApi.id, "vhost test key", hash, apiKeyRaw.slice(0, 12)]
    );

    const admin = await createTestUser(siteApi.id, "superadmin");
    const uv = (await query("SELECT token_version FROM users WHERE id = $1", [admin.id])).rows[0].token_version;
    superadminToken = jwt.sign(
      { sub: admin.id, email: admin.email, name: "Test Admin", role: "superadmin", site_id: admin.site_id, token_version: uv },
      config.jwtSecret,
      { expiresIn: "1h", algorithm: "HS256" }
    );

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", new URL("../views", import.meta.url).pathname);
    app.use(cookieParser());
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    // fetch/undici non permette al client di sovrascrivere l'header Host
    // reale (viene sempre impostato sull'host di connessione): i test usano
    // un header dedicato che SOLO questa app di test traduce in
    // req.headers.host prima di apiHostMiddleware. In produzione il vhost
    // arriva per davvero dal reverse proxy/DNS.
    app.use((req, res, next) => {
      const forcedHost = req.get("X-Test-Host");
      if (forcedHost) req.headers.host = forcedHost;
      next();
    });
    app.use(apiHostMiddleware(apiCloneRoutes));
    app.use(sitesRoutes);
    app.use((req, res) => res.status(200).json({ page: "normal-site-fallback", path: req.path }));
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  test("Host che matcha api_domain: GET /health risponde dal router clone", async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { "X-Test-Host": siteApi.api_domain } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", service: "api" });
  });

  test("Host che matcha api_domain: path sconosciuto + auth valida (legacy) → 404 JSON del router clone", async () => {
    const res = await fetch(`${baseUrl}/qualunque-path`, {
      headers: {
        "X-Test-Host": siteApi.api_domain,
        "Location-Id": String(siteApi.id),
        Authorization: `Bearer ${apiKeyRaw}`,
      },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { statusCode: 404, message: "Endpoint non trovato" });
  });

  test("Host che matcha api_domain: nessuna credenziale → 401 JSON, mai il sito pubblico", async () => {
    const res = await fetch(`${baseUrl}/qualunque-path`, { headers: { "X-Test-Host": siteApi.api_domain } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.statusCode, 401);
  });

  test("Host normale (nessun api_domain): comportamento esistente invariato", async () => {
    const res = await fetch(`${baseUrl}/qualunque-path`, { headers: { "X-Test-Host": siteNormal.domain } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).page, "normal-site-fallback");
  });

  test("api_domain duplicato: l'admin sites risponde 409", async () => {
    const res = await fetch(`${baseUrl}/admin/sites/${siteNormal.id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${superadminToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        name: "Vhost Normal Test",
        domain: siteNormal.domain,
        api_domain: siteApi.api_domain,
      }),
      redirect: "manual",
    });
    assert.equal(res.status, 409);
  });

  test("api_domain con formato hostname invalido: l'admin sites risponde 400", async () => {
    const res = await fetch(`${baseUrl}/admin/sites/${siteNormal.id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${superadminToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        name: "Vhost Normal Test",
        domain: siteNormal.domain,
        api_domain: "not a valid host!!",
      }),
      redirect: "manual",
    });
    assert.equal(res.status, 400);
  });
});
