import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import pool, { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { publicWebhookRouter } from "../src/routes/public-webhooks.js";

// ─────────────────────────────────────────────────────────────────────────
// TASK A (3) — limite di 100 KB sul webhook INBOUND /webhooks/in/.
// Replica l'ordine dei middleware di src/index.js: express.json({limit:
// "100kb"}) sul path /webhooks/in/ PRIMA del parser globale (50mb), che
// deve saltare il path se il body è già parsato. Verifica che il 413
// arrivi anche con Transfer-Encoding: chunked (quindi senza Content-Length,
// dove il fast-path inboundBodyLimit non può intercettare nulla).
// ─────────────────────────────────────────────────────────────────────────

describe("limite body webhook inbound (100 KB)", () => {
  let site, server, baseUrl, port;
  let WEBHOOK_TOKEN;
  let reachedHandler = false;

  before(async () => {
    site = await createTestSite("Webhook Body Limit");
    WEBHOOK_TOKEN = "tok-body-limit";

    const app = express();
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    // Stesso ordine di src/index.js.
    app.use("/webhooks/in/", express.json({ limit: "100kb" }));
    app.use(express.json({ limit: "50mb" }));

    // Middleware di controllo: se la richiesta supera la validazione/parser
    // e raggiunge l'handler del router, impostiamo la flag a true.
    app.use((req, res, next) => {
      if (req.path.includes("/webhooks/in/")) {
        reachedHandler = true;
      }
      next();
    });

    app.use(publicWebhookRouter);

    app.use((err, req, res, _next) => {
      if (err?.type === "entity.too.large" || err?.status === 413) {
        return res.status(413).json({ error: "Body troppo grande (max 100 KB)" });
      }
      res.status(500).json({ error: err.message });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await pool.end();
  });

  beforeEach(() => {
    reachedHandler = false;
  });

  function sendChunked(sizeBytes) {
    return new Promise((resolve) => {
      const options = {
        hostname: "127.0.0.1",
        port: port,
        path: `/webhooks/in/${site.id}/${WEBHOOK_TOKEN}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      };

      const req = http.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, error: null });
        });
      });

      req.on("error", (err) => {
        resolve({ status: null, error: err });
      });

      // Scrive in chunk da 16KB
      const chunkSize = 16 * 1024;
      const chunk = Buffer.alloc(chunkSize, "a");
      let written = 0;

      function write() {
        while (written < sizeBytes) {
          const remaining = sizeBytes - written;
          const toWrite = Math.min(remaining, chunkSize);
          const ok = req.write(chunk.subarray(0, toWrite));
          written += toWrite;
          if (!ok) {
            req.once("drain", write);
            return;
          }
        }
        req.end();
      }

      write();
    });
  }

  test("body chunked da 200 KB su /webhooks/in/ → 413 o ECONNRESET/EPIPE (handler non eseguito)", async () => {
    const result = await sendChunked(200 * 1024);
    
    const is413 = result.status === 413;
    const isClosedSocket = result.error && (result.error.code === "ECONNRESET" || result.error.code === "EPIPE");
    
    assert.ok(is413 || isClosedSocket, `Atteso status 413 o ECONNRESET/EPIPE, ottenuto: status=${result.status}, error=${result.error?.code || result.error?.message}`);
    assert.equal(reachedHandler, false, "L'handler non deve essere stato eseguito");
  });

  test("body entro il limite (50 KB) non viene bloccato dal parser 100kb", async () => {
    const payload = JSON.stringify({ ok: true, filler: "x".repeat(50 * 1024) });
    const res = await fetch(`${baseUrl}/webhooks/in/${site.id}/${WEBHOOK_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    // Non 413: arriva all'handler (401 per token inesistente è atteso e
    // dimostra che il body è stato parsato e consegnato).
    assert.notEqual(res.status, 413);
    assert.equal(reachedHandler, true, "L'handler deve essere stato raggiunto");
  });

  test("content-length sopra 100 KB → 413 (fast-path) e nessuna scrittura", async () => {
    const big = JSON.stringify({ filler: "x".repeat(200 * 1024) });
    const res = await fetch(`${baseUrl}/webhooks/in/${site.id}/${WEBHOOK_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    assert.equal(res.status, 413);
    assert.equal(reachedHandler, false, "L'handler non deve essere stato eseguito");
  });
});
