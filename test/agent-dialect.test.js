import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import apiCloneRoutes from "../src/routes/api-clone/index.js";

// Dialetto "agent": un agtok_ (tabella api_tokens, lo stesso token usato su
// /api/*) può ora autenticarsi anche sul router clone (root-level, vhost
// sites.api_domain), risolvendo il tenant da Location-Id invece che dal
// site_id fisso dell'utente. Copre i 5 punti critici del task: ordine dei
// rami rispetto al dialetto legacy, gate scope esteso con l'allowlist di
// ricerca, header Version non richiesto, regola multi-sito (solo il
// superadmin sceglie il sito), nessuna regressione sui site_api_key.
describe("Clone API — dialetto agent (agtok_ multi-sito)", () => {
  let siteA, siteB, superadminToken, normalToken, readOnlyToken, apiKeyRaw, server, baseUrl;

  before(async () => {
    siteA = await createTestSite("Agent Dialect Site A");
    siteB = await createTestSite("Agent Dialect Site B");

    const superadmin = await createTestUser(siteA.id, "superadmin");
    superadminToken = (await createApiToken(superadmin.id, "agent dialect super", 30, ["read", "write"])).token;

    const normalUser = await createTestUser(siteA.id, "admin");
    normalToken = (await createApiToken(normalUser.id, "agent dialect normal", 30, ["read", "write"])).token;

    const roUser = await createTestUser(siteA.id, "admin");
    readOnlyToken = (await createApiToken(roUser.id, "agent dialect ro", 30, ["read"])).token;

    // site_api_key esistente su siteA: deve continuare a funzionare identico.
    apiKeyRaw = "sitekey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(apiKeyRaw).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "agent dialect test key", hash, apiKeyRaw.slice(0, 12)]
    );

    const app = express();
    app.use(express.json());
    app.use(apiCloneRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  test("agtok_ + Location-Id valido → 200, tenant risolto sul sito richiesto", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      headers: { ...auth(normalToken), "Location-Id": String(siteA.id) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.contacts));
  });

  test("agtok_ superadmin + sito diverso dal proprio → 200 (può scegliere il sito)", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      headers: { ...auth(superadminToken), "Location-Id": String(siteB.id) },
    });
    assert.equal(res.status, 200);
  });

  test("agtok_ non-superadmin + sito diverso dal proprio → 403", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      headers: { ...auth(normalToken), "Location-Id": String(siteB.id) },
    });
    assert.equal(res.status, 403);
  });

  test("agtok_ senza Location-Id → 401", async () => {
    const res = await fetch(`${baseUrl}/contacts`, { headers: auth(normalToken) });
    assert.equal(res.status, 401);
  });

  test("agtok_ non richiede l'header Version (a differenza del dialetto moderno)", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      headers: { ...auth(normalToken), "Location-Id": String(siteA.id) },
    });
    assert.equal(res.status, 200);
  });

  test("agtok_ read-only + POST di scrittura → 403 token_scope_required", async () => {
    const res = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { ...auth(readOnlyToken), "Location-Id": String(siteA.id), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", pipelineId: crypto.randomUUID() }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "token_scope_required");
  });

  test("agtok_ read-only + POST di ricerca (allowlist) → non 403", async () => {
    const res = await fetch(`${baseUrl}/contacts/search`, {
      method: "POST",
      headers: { ...auth(readOnlyToken), "Location-Id": String(siteA.id), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.notEqual(res.status, 403);
  });

  test("agtok_ read-only + POST /contacts/upsert (NON in allowlist, è una scrittura) → 403", async () => {
    const res = await fetch(`${baseUrl}/contacts/upsert`, {
      method: "POST",
      headers: { ...auth(readOnlyToken), "Location-Id": String(siteA.id), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "upsert-agent-dialect@example.test" }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "token_scope_required");
  });

  test("site_api_key esistente: nessuna regressione, comportamento invariato", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      headers: { Authorization: `Bearer ${apiKeyRaw}`, "Location-Id": String(siteA.id) },
    });
    assert.equal(res.status, 200);
  });

  test("token sconosciuto/malformato → 401 (nessun dialetto lo riconosce)", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      headers: { Authorization: "Bearer roba-a-caso", "Location-Id": String(siteA.id) },
    });
    assert.equal(res.status, 401);
  });
});
