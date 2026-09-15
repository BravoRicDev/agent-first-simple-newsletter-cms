import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "zlib";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// Legge le entry di uno zip (central directory + local header) senza
// dipendenze esterne: bastano zlib.inflateRawSync per il metodo deflate.
// Usato solo qui per verificare il contenuto del backup senza estrarlo su disco.
function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  assert.ok(eocdOffset !== -1, "EOCD non trovato: risposta non è uno zip valido");
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);

  const entries = {};
  const CDH_SIG = 0x02014b50;
  for (let i = 0; i < entryCount; i++) {
    assert.equal(buf.readUInt32LE(offset), CDH_SIG, "central directory header non valido");
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);

    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Bug: POST /api/agent/sites/:siteId/backup falliva sempre con Postgres
// 42703 perché la query delle submission joinava su form_submissions.form_id,
// colonna inesistente (vedi db/013_forms.sql: la FK non c'è, solo form_slug
// testo libero). Fix: SELECT diretta su form_submissions WHERE site_id.
describe("backup: fix query form_submissions (niente JOIN su colonna inesistente)", () => {
  let site, user, server, baseUrl, token, submissionData;

  before(async () => {
    site = await createTestSite("Backup Fix Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "backup fix test", 30, ["read", "write"]);
    token = created.token;

    submissionData = { nome: "Mario Rossi", email: "mario@example.test" };
    await query(
      `INSERT INTO form_submissions (site_id, form_slug, data, ip_address)
       VALUES ($1, 'contatti', $2, '127.0.0.1')`,
      [site.id, JSON.stringify(submissionData)]
    );

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test("POST backup risponde 200 (non più 500 42703) e lo zip contiene la submission", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/backup`, {
      method: "POST",
      headers: auth(),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, `atteso 200, ricevuto ${res.status}: ${buf.toString("utf8").slice(0, 500)}`);
    assert.match(res.headers.get("content-type") || "", /application\/zip/);

    const entries = readZipEntries(buf);
    assert.ok(entries["data.json"], "lo zip deve contenere data.json");

    const data = JSON.parse(entries["data.json"].toString("utf8"));
    assert.ok(Array.isArray(data.form_submissions), "form_submissions presente come array");
    assert.ok(
      data.form_submissions.some((s) => s.form_slug === "contatti" && s.data?.email === "mario@example.test"),
      `submission attesa presente nel backup: ${JSON.stringify(data.form_submissions)}`
    );
  });

  test("accesso ad altro sito → 403 (backup non parte)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/999999/backup`, {
      method: "POST",
      headers: auth(),
    });
    assert.equal(res.status, 403);
  });
});
