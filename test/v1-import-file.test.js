import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// Import avanzato su /v1/import: file CSV/JSON via multipart e body text/csv,
// con validazione per-riga (numero di riga) e report per job.
describe("ONDA 3 — import avanzato /v1/import (file CSV/JSON + text/csv)", () => {
  let server, baseUrl, siteA, apiKeyA;

  before(async () => {
    siteA = await createTestSite("IMP FileUpload A");
    const crypto = (await import("crypto")).default;
    const raw = "testkey_imp_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key", crypto.createHash("sha256").update(raw).digest("hex"), raw.slice(0, 12)]
    );
    apiKeyA = raw;

    const app = express();
    app.use(express.json({ type: "application/json" }));
    app.use(express.urlencoded({ extended: false }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    await query(`DELETE FROM contacts WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM import_jobs WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM site_api_keys WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM sites WHERE id = $1`, [siteA.id]);
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  async function api(path, { method = "POST", headers = {}, body, siteId = siteA.id, token = apiKeyA } = {}) {
    const h = { ...headers };
    h["Location-Id"] = String(siteId);
    h["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}/v1${path}`, { method, headers: h, body });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  test("multipart CSV → importa contatti e registra job con filename", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["email,tags,notes\n" +
      `${uniqueEmail("impcsv-a")},lead,nota a\n` +
      `${uniqueEmail("impcsv-b")},prospect,nota b\n`], { type: "text/csv" }), "contatti.csv");
    fd.append("created_by", "admin@local");
    const r = await api("/import", { body: fd });
    assert.equal(r.status, 201);
    assert.ok(r.body.job_id);
    assert.equal(r.body.imported, 2);
    assert.equal(r.body.skipped, 0);
    const job = (await query("SELECT * FROM import_jobs WHERE id = $1", [r.body.job_id])).rows[0];
    assert.equal(job.filename, "contatti.csv");
  });

  test("multipart CSV con righe invalide → skipped con numero di riga (header=1)", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["email,tags\n" +
      `${uniqueEmail("impcsv-ok")},ok\n` +
      `non-valida,ok\n` +
      `,ok\n`], { type: "text/csv" }), "b.csv");
    const r = await api("/import", { body: fd });
    assert.equal(r.status, 201);
    assert.equal(r.body.imported, 1);
    assert.equal(r.body.skipped, 2);
    // riga fisica: header=1, quindi riga 3 = "non-valida", riga 4 = vuota
    const lines = r.body.errors.map((e) => e.line).sort((a, b) => a - b);
    assert.deepEqual(lines, [3, 4]);
  });

  test("multipart JSON array come file → importa contatti", async () => {
    const fd = new FormData();
    const payload = JSON.stringify([{ email: uniqueEmail("impjson-a") }, { email: uniqueEmail("impjson-b") }]);
    fd.append("file", new Blob([payload], { type: "application/json" }), "dati.json");
    const r = await api("/import", { body: fd });
    assert.equal(r.status, 201);
    assert.equal(r.body.imported, 2);
  });

  test("body text/csv → importa contatti (content-type text/csv)", async () => {
    const csv = "email,status\n" + `${uniqueEmail("imptext-a")},open\n`;
    const r = await api("/import", {
      headers: { "Content-Type": "text/csv" },
      body: csv,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.imported, 1);
    const job = (await query("SELECT * FROM import_jobs WHERE id = $1", [r.body.job_id])).rows[0];
    assert.equal(job.filename, "import.csv");
  });

  test("body JSON attuale (backward compatible) continua a funzionare", async () => {
    const r = await api("/import", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacts: [{ email: uniqueEmail("impjson-legacy") }] }),
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.imported >= 1);
  });

  test("file JSON malformato → job con errore line 1 e 0 importati", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["{ non valido json !!!"], { type: "application/json" }), "bad.json");
    const r = await api("/import", { body: fd });
    assert.equal(r.status, 201);
    assert.equal(r.body.imported, 0);
    assert.ok(r.body.errors.length >= 1);
    assert.equal(r.body.errors[0].line, 1);
  });

  test("GET /v1/import/jobs → job con filename nello stats/record", async () => {
    const r = await api("/import/jobs", { method: "GET" });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.jobs));
    assert.ok(r.body.jobs.some((j) => j.filename === "contatti.csv"));
  });
});