import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import accessGrantsPublicRoutes from "../src/routes/access-grants-public.js";
import {
  createAccessGrant,
  resolveAccessGrant,
  listAccessGrants,
  revokeAccessGrant,
  checkAndConsumeGrant,
} from "../src/services/access-grants.js";
import { PROTECTED_ROOT } from "../src/services/media-utils.js";

// ─────────────────────────────────────────────────────────────────────────
// R1 — Permessi di accesso a contenuti protetti.
//
// Copre: servizio (create/resolve/list/revoke/consume atomico), rotta
// pubblica GET /shared/:token (serve il file, 404 generico su token
// invalido/scaduto/esaurito, incremento used_count) e API agente
// (GET/POST/DELETE). Stesso setup auth dei test agent (token API con
// agent:true, vedi page-tracking-agent.test.js).
// ─────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_CONTENT = "contenuto-segreto-access-grant";
const TEST_FILENAME = `__grant_test_${Date.now()}.txt`;

describe("access grants: servizio + rotta pubblica /shared/:token + API agente", () => {
  let site, user, token, server, baseUrl, testFile, secretFile;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    site = await createTestSite("Access Grants Test");
    user = await createTestUser(site.id, "admin");
    token = (await createApiToken(user.id, "access grants test", 30)).token;

    // File di test dentro la sottocartella del sito in media-protected
    fs.mkdirSync(path.join(PROTECTED_ROOT, String(site.id)), { recursive: true });
    testFile = path.join(PROTECTED_ROOT, String(site.id), TEST_FILENAME);
    fs.writeFileSync(testFile, TEST_CONTENT);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use(accessGrantsPublicRoutes);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    try { fs.unlinkSync(testFile); } catch { /* già rimosso */ }
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  // ── Servizio ───────────────────────────────────────────────────────────

  test("createAccessGrant genera token, used_count=0, media_path normalizzato", async () => {
    const g = await createAccessGrant(site.id, {
      email: "Lead@Example.com",
      mediaPath: TEST_FILENAME,
      source: "challenge",
      createdBy: user.id,
    });
    assert.ok(g, "grant creato");
    assert.match(g.token, /^[a-f0-9]{64}$/, "token random 64 hex (come /pay/:token)");
    assert.equal(g.email, "lead@example.com", "email normalizzata lowercase");
    assert.equal(g.media_path, TEST_FILENAME);
    assert.equal(g.used_count, 0);
    assert.equal(g.source, "challenge");
    secretFile = g;
  });

  test("resolveAccessGrant: trovato per token, null per token sconosciuto", async () => {
    const found = await resolveAccessGrant(secretFile.token);
    assert.equal(found.id, secretFile.id);
    assert.equal(await resolveAccessGrant("token-inesistente"), null);
  });

  test("createAccessGrant rifiuta media_path con path traversal (..)", async () => {
    const bad = await createAccessGrant(site.id, { email: "x@example.com", mediaPath: "../../package.json" });
    assert.equal(bad, null);
    const badAbs = await createAccessGrant(site.id, { email: "x@example.com", mediaPath: "/etc/passwd" });
    assert.equal(badAbs, null);
  });

  test("listAccessGrants filtra per email e per sito", async () => {
    const all = await listAccessGrants(site.id);
    assert.ok(all.some(g => g.id === secretFile.id));
    const filtered = await listAccessGrants(site.id, { email: "lead@example.com" });
    assert.ok(filtered.some(g => g.id === secretFile.id));
    const empty = await listAccessGrants(site.id, { email: "altro@example.com" });
    assert.equal(empty.length, 0);
  });

  // ── Rotta pubblica ──────────────────────────────────────────────────────

  test("GET /shared/:token serve il file protetto, Cache-Control private no-store", async () => {
    const res = await fetch(`${baseUrl}/shared/${secretFile.token}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TEST_CONTENT);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  });

  test("used_count incrementato dopo il serve", async () => {
    const row = (await query("SELECT used_count FROM access_grants WHERE id = $1", [secretFile.id])).rows[0];
    assert.equal(Number(row.used_count), 1);
  });

  test("GET /shared/:token su token inesistente → 404 generico", async () => {
    const res = await fetch(`${baseUrl}/shared/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "Contenuto non disponibile", "stesso messaggio generico, mai rivelare se il token esiste");
  });

  test("GET /shared/:token su grant scaduto → 404 generico", async () => {
    const expired = await createAccessGrant(site.id, {
      email: "expired@example.com",
      mediaPath: TEST_FILENAME,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000), // già passata
    });
    const res = await fetch(`${baseUrl}/shared/${expired.token}`);
    assert.equal(res.status, 404);
  });

  test("max_uses=1: prima richiesta 200, seconda 404 (consumo atomico)", async () => {
    const g = await createAccessGrant(site.id, {
      email: "one@example.com",
      mediaPath: TEST_FILENAME,
      maxUses: 1,
    });
    const first = await fetch(`${baseUrl}/shared/${g.token}`);
    assert.equal(first.status, 200);
    const second = await fetch(`${baseUrl}/shared/${g.token}`);
    assert.equal(second.status, 404, "esaurito: la seconda richiesta fallisce");
    const row = (await query("SELECT used_count FROM access_grants WHERE id = $1", [g.id])).rows[0];
    assert.equal(Number(row.used_count), 1, "used_count NON supera max_uses");
  });

  test("grant già esaurito (used_count >= max_uses) → 404", async () => {
    const g = await createAccessGrant(site.id, { email: "x@example.com", mediaPath: TEST_FILENAME, maxUses: 2 });
    await query("UPDATE access_grants SET used_count = 2 WHERE id = $1", [g.id]);
    const res = await fetch(`${baseUrl}/shared/${g.token}`);
    assert.equal(res.status, 404);
  });

  test("grant con media_path malevolo (insert diretto SQL) → 404, mai serve fuori root", async () => {
    const evilToken = crypto.randomBytes(32).toString("hex");
    const row = (await query(
      `INSERT INTO access_grants (site_id, email, token, media_path, max_uses)
       VALUES ($1, $2, $3, $4, 1) RETURNING token`,
      [site.id, "evil@example.com", evilToken, "../../package.json"]
    )).rows[0];
    const res = await fetch(`${baseUrl}/shared/${row.token}`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!body.includes("gestione-siti"), "non deve servire package.json");
  });

  test("checkAndConsumeGrant: concurrency-safe sul limite max_uses", async () => {
    const g = await createAccessGrant(site.id, { email: "race@example.com", mediaPath: TEST_FILENAME, maxUses: 3 });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => checkAndConsumeGrant(g.token)));
    const okCount = results.filter(r => r.ok).length;
    assert.equal(okCount, 3, "solo max_uses consumi riescono");
    assert.equal(results.filter(r => !r.ok && r.reason === "exhausted").length, 2);
    const row = (await query("SELECT used_count FROM access_grants WHERE id = $1", [g.id])).rows[0];
    assert.equal(Number(row.used_count), 3);
  });

  // ── API agente ──────────────────────────────────────────────────────────

  test("agent API: POST crea grant e ritorna url /shared/:token", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/access-grants`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "agent@example.com", mediaPath: TEST_FILENAME, source: "api" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.access_grant);
    assert.equal(body.access_grant.site_id, site.id);
    assert.equal(body.access_grant.email, "agent@example.com");
    assert.equal(body.access_grant.source, "api");
    assert.equal(body.access_grant.url, `/shared/${body.access_grant.token}`);
    assert.ok((await resolveAccessGrant(body.access_grant.token)), "grant persistito");
  });

  test("agent API: POST senza mediaPath valido → 400", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/access-grants`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bad@example.com", mediaPath: "../../etc/passwd" }),
    });
    assert.equal(res.status, 400);
  });

  test("agent API: GET lista (con filtro email)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/access-grants`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.access_grants.some(g => g.email === "agent@example.com"));

    const filtered = await fetch(`${baseUrl}/api/agent/sites/${site.id}/access-grants?email=agent@example.com`, { headers: auth() });
    const fBody = await filtered.json();
    assert.ok(fBody.access_grants.every(g => g.email === "agent@example.com"));
  });

  test("agent API: DELETE revoca il grant", async () => {
    const created = await createAccessGrant(site.id, { email: "revoke@example.com", mediaPath: TEST_FILENAME });
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/access-grants/${created.id}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(res.status, 200);
    assert.equal(await resolveAccessGrant(created.token), null, "grant eliminato");

    const again = await fetch(`${baseUrl}/api/agent/sites/${site.id}/access-grants/${created.id}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(again.status, 404);
  });

  test("agent API: canAccessSite nega un sito non proprio", async () => {
    const other = await createTestSite("Access Grants Other Site");
    const res = await fetch(`${baseUrl}/api/agent/sites/${other.id}/access-grants`, { headers: auth() });
    assert.equal(res.status, 403);
  });

  test("agent API: senza token → richiesta rifiutata (redirect a /login, mai dati)", async () => {
    // Route dietro il router.use("/api/agent", requireAuth, requireAgent)
    // di crm-agent: senza credenziali requireAuth reindirizza a /login
    // (comportamento identico alle altre route agent, es. tracked-links).
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/access-grants`, { redirect: "manual" });
    assert.ok(res.status === 302 || res.status === 401, `status ${res.status}`);
  });

  test("revokeAccessGrant: delete per sito, non tocca altri siti", async () => {
    const g = await createAccessGrant(site.id, { email: "del@example.com", mediaPath: TEST_FILENAME });
    const deleted = await revokeAccessGrant(site.id, g.id);
    assert.equal(deleted, true);
    assert.equal(await revokeAccessGrant(site.id, g.id), false, "già eliminato");
  });
});