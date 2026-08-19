import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import mediaProtectedRoutes from "../src/routes/media-protected.js";

// ─────────────────────────────────────────────────────────────────────────
// Media PROTETTI — cartella servita SOLO via route Express con
// autorizzazione (mai express.static). La route è deny-by-default:
//   401 senza utente · 403 senza ruolo admin · 404 su path invalidi.
// Il file di test viene creato a runtime nella root protetta (volume
// Docker montato) e rimosso in after: nessun residuo sul server.
// ─────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTECTED_ROOT = path.resolve(__dirname, "../media-protected");
const TEST_FILENAME = `__protected_test_${Date.now()}.txt`;
const TEST_CONTENT = "contenuto-segreto-del-test";

describe("media protetti: route con autorizzazione (deny by default)", () => {
  let site, adminUser, collabUser, adminToken, collabToken, server, baseUrl;

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    // File di prova nella cartella protetta (visibile perché il volume
    // Docker monta media-protected/ sia in produzione sia nei test).
    fs.mkdirSync(PROTECTED_ROOT, { recursive: true });
    fs.writeFileSync(path.join(PROTECTED_ROOT, TEST_FILENAME), TEST_CONTENT);

    site = await createTestSite("Media Protetti Test");
    adminUser = await createTestUser(site.id, "admin");
    collabUser = await createTestUser(site.id, "collaboratore");
    adminToken = (await createApiToken(adminUser.id, "media-protected admin", 30)).token;
    collabToken = (await createApiToken(collabUser.id, "media-protected collab", 30)).token;

    const app = express();
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(mediaProtectedRoutes);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    try { fs.unlinkSync(path.join(PROTECTED_ROOT, TEST_FILENAME)); } catch { /* già rimosso */ }
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  test("senza autenticazione → bloccato (redirect login, mai il file)", async () => {
    // redirect:"manual" per vedere il 302 senza seguirlo (nel server di
    // test /login non esiste → altrimenti 404 "Cannot GET /login").
    const res = await fetch(`${baseUrl}/media-protected/${TEST_FILENAME}`, { redirect: "manual" });
    assert.equal(res.status, 302); // requireAuth: path non-API → redirect a /login
    const body = await res.text();
    assert.ok(!body.includes(TEST_CONTENT), "il contenuto NON deve essere servito");
  });

  test("utente senza ruolo admin → 403 (deny by default)", async () => {
    const res = await fetch(`${baseUrl}/media-protected/${TEST_FILENAME}`, {
      headers: auth(collabToken),
    });
    assert.equal(res.status, 403);
    const body = await res.text();
    assert.ok(!body.includes(TEST_CONTENT), "il contenuto NON deve essere servito");
  });

  test("admin → 200, contenuto corretto, Cache-Control private no-store", async () => {
    const res = await fetch(`${baseUrl}/media-protected/${TEST_FILENAME}`, {
      headers: auth(adminToken),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TEST_CONTENT);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  });

  test("path traversal (../) → 404, mai file fuori dalla root", async () => {
    const res = await fetch(`${baseUrl}/media-protected/..%2f..%2fetc%2fpasswd`, {
      headers: auth(adminToken),
    });
    assert.equal(res.status, 404);
    const res2 = await fetch(`${baseUrl}/media-protected/../../package.json`, {
      headers: auth(adminToken),
    });
    assert.equal(res2.status, 404);
  });

  test("file inesistente → 404", async () => {
    const res = await fetch(`${baseUrl}/media-protected/non-esiste-${Date.now()}.txt`, {
      headers: auth(adminToken),
    });
    assert.equal(res.status, 404);
  });

  test("segmento invalido (spazi/caratteri pericolosi) → 404", async () => {
    const res = await fetch(`${baseUrl}/media-protected/foo%20bar%00.txt`, {
      headers: auth(adminToken),
    });
    assert.equal(res.status, 404);
  });
});
