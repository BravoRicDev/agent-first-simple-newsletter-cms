import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import rateLimit from "express-rate-limit";
import authRoutes from "../src/routes/auth.js";
import { closeDb } from "./helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// Rate limit su POST /api/auth/login (anti email bombing):
//  - loginLimiter: 10 richieste / 15 min per IP
//  - loginAccountLimiter: 10 richieste / 15 min per EMAIL (keyGenerator sul
//    body.email → un attaccante che ruota IP non può martellare un account)
// Stessa configurazione di src/index.js. Server dedicato → bucket isolati,
// nessuna interferenza con gli altri file (node --test = processo per file).
// ─────────────────────────────────────────────────────────────────────────

describe("auth: rate limit login anti email bombing", () => {
  let server, baseUrl;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: () => ({ error: "too many login attempts" }),
    standardHeaders: true,
    legacyHeaders: false,
  });

  const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => (req.body?.email || "").toLowerCase().trim() || req.ip,
    message: () => ({ error: "too many login attempts" }),
    standardHeaders: true,
    legacyHeaders: false,
  });

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use("/api/auth/login", loginLimiter, loginAccountLimiter);
    app.use(authRoutes);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
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

  test("stessa email martellata: 10× 200 poi 429 (email bombing bloccato)", async () => {
    const email = "bomb-target@example.test"; // inesistente → generateAndSend ritorna senza SMTP
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      statuses.push(res.status);
    }
    // Le prime 10 passano (risposta identica {sent:true}), l'11ª e la 12ª 429.
    assert.equal(statuses.slice(0, 10).every((s) => s === 200), true, `attese 10×200, visti: ${statuses.slice(0, 10).join(",")}`);
    assert.ok(statuses.slice(10).every((s) => s === 429), `attesi 429 dopo il limite, visti: ${statuses.slice(10).join(",")}`);
  });

  test("email diverse dallo stesso IP: comunque 429 dopo 10 richieste (limite per-IP)", async () => {
    // Reset del bucket per-IP: il primo test ha già esaurito il limite
    // (stesso server, stesso IP). express-rate-limit v8 espone resetKey(),
    // non resetAll() → resettiamo i formati di loopback possibili.
    ["::1", "127.0.0.1", "::ffff:127.0.0.1"].forEach((ip) => loginLimiter.resetKey(ip));
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `rot-${i}-${Date.now()}@example.test` }),
      });
      statuses.push(res.status);
    }
    assert.equal(statuses.slice(0, 10).every((s) => s === 200), true);
    assert.ok(statuses.slice(10).every((s) => s === 429), `attesi 429 per-IP, visti: ${statuses.slice(10).join(",")}`);
  });
});
