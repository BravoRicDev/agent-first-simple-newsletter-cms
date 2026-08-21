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