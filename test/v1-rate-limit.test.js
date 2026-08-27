import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import rateLimit from "express-rate-limit";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";
import { v1BodyValidator } from "../src/middleware/body-validate-v1.js";

// ─────────────────────────────────────────────────────────────────────────
// Rate limiting + body validation per la surface /v1.
// Server dedicati per ogni describe bucket → bucket isolati, nessuna
// interferenza (node --test = processo per file).
// closeDb() chiamato UNA volta alla fine (after globale).
// ─────────────────────────────────────────────────────────────────────────

const cryptoPromise = import("crypto").then((m) => m.default);

async function createSiteWithKey(name) {
  const site = await createTestSite(name);
  const crypto = await cryptoPromise;
  const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  await query(
    "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
    [site.id, name + "-key", hash, raw.slice(0, 12)]
  );
  return { site, apiKey: raw };
}

async function makeServer(extraMiddleware) {
  const { requireTenant } = await import("../src/middleware/tenant-api.js");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/v1", requireTenant(), ...extraMiddleware, v1Routes);
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const baseUrl = `http://localhost:${server.address().port}`;
      resolve({ server, baseUrl });
    });
  });
}

const topLevelCleanup = [];

after(async () => {
  for (const s of topLevelCleanup) {
    s?.closeAllConnections?.();
    s?.close();
  }
  await closeDb();
});

// ── Suite 1: rate limiting GET ───────────────────────────────────────

describe("v1: rate limiting GET", () => {
  let server, baseUrl;
  let site, apiKey;

  const testLimiter = rateLimit({
    windowMs: 1000,
    max: 5,
    message: { error: "Troppe richieste. Riprova piu tardi." },
    standardHeaders: true,
    legacyHeaders: false,
  });

  before(async () => {
    const r = await createSiteWithKey("V1 Rate GET");
    site = r.site;
    apiKey = r.apiKey;
    const srv = await makeServer([testLimiter]);
    server = srv.server;
    baseUrl = srv.baseUrl;
    topLevelCleanup.push(server);
  });

  const headers = () => ({
    "Location-Id": String(site.id),
    Authorization: `Bearer ${apiKey}`,
  });

  test("una singola GET /v1/contacts -> 200", async () => {
    const res = await fetch(`${baseUrl}/v1/contacts`, { headers: headers() });
    assert.equal(res.status, 200);
  });

  test("5 GET poi la 6a e 429 (bucket esaurito)", async () => {
    testLimiter.resetKey("::1");
    testLimiter.resetKey("::ffff:127.0.0.1");
    testLimiter.resetKey("127.0.0.1");

    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${baseUrl}/v1/contacts`, { headers: headers() });
      statuses.push(res.status);
    }
    assert.equal(statuses.slice(0, 5).every((s) => s === 200), true,
      `attese 5x200, visti: ${statuses.slice(0, 5).join(",")}`);
    assert.ok(statuses.slice(5).every((s) => s === 429),
      `attesi 429 dopo limite, visti: ${statuses.slice(5).join(",")}`);
  });

  test("dopo reset key, GET torna 200", async () => {
    testLimiter.resetKey("::1");
    testLimiter.resetKey("::ffff:127.0.0.1");
    testLimiter.resetKey("127.0.0.1");
    const res = await fetch(`${baseUrl}/v1/contacts`, { headers: headers() });
    assert.equal(res.status, 200);
  });

  test("429 ha header RateLimit-Remaining", async () => {
    testLimiter.resetKey("::1");
    testLimiter.resetKey("::ffff:127.0.0.1");
    testLimiter.resetKey("127.0.0.1");
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${baseUrl}/v1/contacts`, { headers: headers() });
      if (res.status === 429) {
        assert.ok(res.headers.get("ratelimit-remaining") !== null,
          "RateLimit-Remaining header presente su 429");
        assert.ok(res.headers.get("ratelimit-reset") !== null,
          "RateLimit-Reset header presente su 429");
      }
    }
  });
});

// ── Suite 2: rate limiting WRITE (POST) ─────────────────────────────

describe("v1: rate limiting WRITE (POST)", () => {
  let server, baseUrl;
  let site, apiKey;

  const writeLimiter = rateLimit({
    windowMs: 1000,
    max: 3,
    message: { error: "Troppe richieste. Riprova piu tardi." },
    standardHeaders: true,
    legacyHeaders: false,
  });

  before(async () => {
    const r = await createSiteWithKey("V1 Rate WRITE");
    site = r.site;
    apiKey = r.apiKey;
    const srv = await makeServer([writeLimiter]);
    server = srv.server;
    baseUrl = srv.baseUrl;
    topLevelCleanup.push(server);
  });

  const headers = () => ({
    "Location-Id": String(site.id),
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });

  test("3 POST /v1/custom-fields poi la 4a e 429", async () => {
    writeLimiter.resetKey("::1");
    writeLimiter.resetKey("::ffff:127.0.0.1");
    writeLimiter.resetKey("127.0.0.1");

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/v1/custom-fields`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: `Field ${i}`, type: "text", objectKey: "contact" }),
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.slice(0, 3).every((s) => s !== 429),
      `attese prime 3 non 429, viste: ${statuses.slice(0, 3).join(",")}`);
    assert.ok(statuses.slice(3).every((s) => s === 429),
      `attesi 429 dopo limite write, visti: ${statuses.slice(3).join(",")}`);
  });
});

// ── Suite 3: body validation ────────────────────────────────────────

describe("v1: body validation", () => {
  let server, baseUrl;
  let site, apiKey;

  before(async () => {
    const r = await createSiteWithKey("V1 Body Val");
    site = r.site;
    apiKey = r.apiKey;
    const srv = await makeServer([v1BodyValidator()]);
    server = srv.server;
    baseUrl = srv.baseUrl;
    topLevelCleanup.push(server);
  });

  const authHeaders = (extra) => ({
    "Location-Id": String(site.id),
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  });

  test("POST /v1/custom-fields con Content-Type sbagliato -> 415", async () => {
    const res = await fetch(`${baseUrl}/v1/custom-fields`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "text/plain" }),
      body: "not json",
    });
    assert.equal(res.status, 415);
    const body = await res.json();
    assert.ok(body.error?.includes("Content-Type"),
      `errore menziona Content-Type: ${body.error}`);
  });

  test("GET /v1/contacts passa senza body validation", async () => {
    const res = await fetch(`${baseUrl}/v1/contacts`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
  });

  test("DELETE /v1/custom-fields/9999 passa senza body validation", async () => {
    const res = await fetch(`${baseUrl}/v1/custom-fields/9999`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(res.status, 404);
  });
});

// ── Suite 4: loopback exemption ─────────────────────────────────────

describe("v1: loopback exemption", () => {
  let server, baseUrl;
  let site, apiKey;

  const testLimiter = rateLimit({
    windowMs: 1000,
    max: 3,
    message: { error: "Troppe richieste. Riprova piu tardi." },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1",
  });

  before(async () => {
    const r = await createSiteWithKey("V1 Loopback");
    site = r.site;
    apiKey = r.apiKey;
    const srv = await makeServer([testLimiter]);
    server = srv.server;
    baseUrl = srv.baseUrl;
    topLevelCleanup.push(server);
  });

  const headers = () => ({
    "Location-Id": String(site.id),
    Authorization: `Bearer ${apiKey}`,
  });

  test("loopback (localhost) esente: 6 GET oltre il limite ma tutte 200", async () => {
    testLimiter.resetKey("::1");
    testLimiter.resetKey("::ffff:127.0.0.1");
    testLimiter.resetKey("127.0.0.1");

    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${baseUrl}/v1/contacts`, { headers: headers() });
      statuses.push(res.status);
    }
    assert.ok(statuses.every((s) => s === 200),
      `loopback esente da rate limit: ${statuses.join(",")}`);
  });
});

// ── Suite 5: rate limiting per-tenant via tenant_config ──────────────

describe("v1: rate limiting per-tenant via tenant_config", () => {
  let server, baseUrl;
  let siteA, apiKeyA, siteB, apiKeyB;

  before(async () => {
    const rA = await createSiteWithKey("RL PerTenant A");
    siteA = rA.site;
    apiKeyA = rA.apiKey;
    const rB = await createSiteWithKey("RL PerTenant B");
    siteB = rB.site;
    apiKeyB = rB.apiKey;

    const { requireTenant } = await import("../src/middleware/tenant-api.js");
    const { v1RateLimiter: realLimiter, refreshConfigCache } = await import("../src/middleware/rate-limit-v1.js");
    const v1BodyValidatorMod = await import("../src/middleware/body-validate-v1.js");
    const v1Routes = (await import("../src/routes/v1.js")).default;

    const app = express();
    app.use(express.json());
    // skipLoopback: false — i test girano da localhost, vogliamo che il rate limit
    // sia effettivamente applicato (non saltato come in produzione).
    app.use("/v1", requireTenant(), realLimiter({ skipLoopback: false }), v1BodyValidatorMod.v1BodyValidator(), v1Routes);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });

    const srv = app.listen(0, () => {
      baseUrl = `http://localhost:${srv.address().port}`;
    });
    server = srv;
    await new Promise((resolve) => server.on("listening", resolve));
    topLevelCleanup.push(server);

    // Pre-carica cache all'avvio
    await refreshConfigCache();
  });

  async function fetchWithTenant(method, path, tenantId, apiKey, body) {
    const opts = {
      method,
      headers: {
        "Location-Id": String(tenantId),
        "Authorization": `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    return fetch(`${baseUrl}/v1${path}`, opts);
  }

  test("GET senza config usa default 120/min (5 richieste tutte 200)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetchWithTenant("GET", "/contacts", siteB.id, apiKeyB);
      assert.equal(res.status, 200, `richiesta ${i} fallita: ${res.status}`);
    }
  });

  test("config rate_limits generalMax=2 blocca dopo 2 GET (siteA)", async () => {
    await query(
      `INSERT INTO tenant_config (site_id, key, value) VALUES ($1, 'rate_limits', $2::jsonb)
       ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [siteA.id, JSON.stringify({ generalMax: 2, writeMax: 2 })]
    );
    const { refreshConfigCache: refresh } = await import("../src/middleware/rate-limit-v1.js");
    await refresh();

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetchWithTenant("GET", "/contacts", siteA.id, apiKeyA);
      statuses.push(res.status);
    }

    assert.ok(statuses[0] === 200 && statuses[1] === 200,
      `prime due GET dovrebbero essere 200: ${statuses.slice(0, 2)}`);
    assert.ok(statuses.slice(2).some((s) => s === 429),
      `dopo limite attesi 429: ${statuses}`);

    // Cleanup — non influisce su test successivi perche usano tenant diversi
    await query("DELETE FROM tenant_config WHERE site_id = $1 AND key = 'rate_limits'", [siteA.id]);
    await refresh();
  });

  test("config rate_limits solo writeMax=1 blocca POST (siteC isolato)", async () => {
    const siteC = await createSiteWithKey("RL PerTenant C");
    await query(
      `INSERT INTO tenant_config (site_id, key, value) VALUES ($1, 'rate_limits', $2::jsonb)
       ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [siteC.site.id, JSON.stringify({ writeMax: 1 })]
    );
    const { refreshConfigCache: refresh } = await import("../src/middleware/rate-limit-v1.js");
    await refresh();

    // POST: la prima 201 (custom-field creato), la seconda 429
    const res1 = await fetchWithTenant("POST", "/custom-fields", siteC.site.id, siteC.apiKey,
      { field_key: "PerTenantC1", name: "PerTenant C Field 1", type: "text", object_key: "contact" });

    // GET (read, generalMax default 120) deve passare
    const getRes = await fetchWithTenant("GET", "/contacts", siteC.site.id, siteC.apiKey);
    assert.equal(getRes.status, 200, "GET deve passare con default generalMax");
    assert.equal(res1.status, 201, "prima POST deve essere 201 (custom field creato)");

    const res2 = await fetchWithTenant("POST", "/custom-fields", siteC.site.id, siteC.apiKey,
      { field_key: "PerTenantC2", name: "PerTenant C Field 2", type: "text", object_key: "contact" });
    assert.equal(res2.status, 429, "seconda POST deve essere 429 (write limit 1)");

    // Altre POST ancora 429
    const res3 = await fetchWithTenant("POST", "/custom-fields", siteC.site.id, siteC.apiKey,
      { field_key: "PerTenantC3", name: "PerTenant C Field 3", type: "text", object_key: "contact" });
    assert.equal(res3.status, 429, "terza POST deve essere 429");

    await query("DELETE FROM tenant_config WHERE site_id = $1 AND key = 'rate_limits'", [siteC.site.id]);
    await refresh();
  });

  test("isolamento tenant: B senza config non risente del limite di A (siteD)", async () => {
    const siteD = await createSiteWithKey("RL PerTenant D");
    await query(
      `INSERT INTO tenant_config (site_id, key, value) VALUES ($1, 'rate_limits', $2::jsonb)
       ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [siteD.site.id, JSON.stringify({ generalMax: 1 })]
    );
    const { refreshConfigCache: refresh } = await import("../src/middleware/rate-limit-v1.js");
    await refresh();

    // D con generalMax=1: prima GET 200, seconda 429
    const d1 = await fetchWithTenant("GET", "/contacts", siteD.site.id, siteD.apiKey);
    assert.equal(d1.status, 200, "prima GET di D deve essere 200");
    const d2 = await fetchWithTenant("GET", "/contacts", siteD.site.id, siteD.apiKey);
    assert.equal(d2.status, 429, "seconda GET di D deve essere 429");

    // B senza config: tutte 200
    const b1 = await fetchWithTenant("GET", "/contacts", siteB.id, apiKeyB);
    assert.equal(b1.status, 200, "B non deve essere limitato");

    await query("DELETE FROM tenant_config WHERE site_id = $1 AND key = 'rate_limits'", [siteD.site.id]);
    await refresh();
  });
});