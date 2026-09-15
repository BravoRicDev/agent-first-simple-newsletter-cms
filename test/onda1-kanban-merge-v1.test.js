import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 1 — Kanban board + Contact Merge sulla surface /v1
describe("ONDA 1 — kanban board + merge API /v1", () => {
  let server, baseUrl;
  let site, apiKey;
  let contactEmailSrc, contactEmailDst;

  before(async () => {
    site = await createTestSite("Kanban Merge Test");

    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [site.id, "km-key", hash, raw.slice(0, 12)]
    );
    apiKey = { raw };

    // Crea pipeline con stages custom
    await query(
      `INSERT INTO pipelines (site_id, name, stages, is_default)
       VALUES ($1, 'Pipeline Test', $2::jsonb, true)`,
      [site.id, JSON.stringify([
        { key: "lead", label: "Lead", color: "#eee", position: 0 },
        { key: "contattato", label: "Contattato", color: "#ddd", position: 1 },
        { key: "proposta", label: "Proposta", color: "#ccc", position: 2 },
        { key: "vinto", label: "Vinto", color: "green", position: 3 },
        { key: "perso", label: "Perso", color: "red", position: 4 },
      ])]
    );

    // Crea contatti per merge test
    contactEmailSrc = `src-${crypto.randomBytes(4).toString("hex")}@example.test`;
    contactEmailDst = `dst-${crypto.randomBytes(4).toString("hex")}@example.test`;

    await query(
      "INSERT INTO contacts (site_id, email, tags, score, notes) VALUES ($1, $2, $3, $4, $5)",
      [site.id, contactEmailSrc, "{tag_a,tag_b}", 10, "Nota originale"]
    );
    await query(
      "INSERT INTO contacts (site_id, email, tags, score, notes) VALUES ($1, $2, $3, $4, $5)",
      [site.id, contactEmailDst, "{tag_b,tag_c}", 5, "Nota destinazione"]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: err.message, stack: err.stack });
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

  const auth = () => ({
    "Location-Id": String(site.id),
    Authorization: `Bearer ${apiKey.raw}`,
    Version: "2017-04-19",
  });
  const postJson = (url, body) => fetch(url, {
    method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // ── Kanban Board ──────────────────────────────────────────────────

  test("GET /opportunities/board — vuota", async () => {
    const res = await fetch(`${baseUrl}/v1/opportunities/board`, { headers: auth() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.pipelines));
    assert.ok(data.pipelines.length >= 1);
    assert.ok(Array.isArray(data.board));
    assert.ok(data.currentPipeline);
  });

  test("GET /opportunities/board — con opportunità raggruppate per stage", async () => {
    // Crea 3 opportunità in stadi diversi
    const email = `opp-${crypto.randomBytes(4).toString("hex")}@example.test`;
    await query(
      "INSERT INTO contacts (site_id, email) VALUES ($1, $2) ON CONFLICT (site_id, email) DO NOTHING",
      [site.id, email]
    );
    await query(
      `INSERT INTO opportunities (site_id, contact_email, title, stage, status, pipeline_id)
       VALUES ($1, $2, 'Board Opp 1', 'lead', 'open', (SELECT id FROM pipelines WHERE site_id = $1 LIMIT 1)),
              ($1, $2, 'Board Opp 2', 'contattato', 'open', (SELECT id FROM pipelines WHERE site_id = $1 LIMIT 1)),
              ($1, $2, 'Board Opp 3', 'proposta', 'open', (SELECT id FROM pipelines WHERE site_id = $1 LIMIT 1))`,
      [site.id, email]
    );

    const res = await fetch(`${baseUrl}/v1/opportunities/board`, { headers: auth() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.board.length >= 5); // 5 stages

    const leadCol = data.board.find(c => c.key === "lead");
    assert.ok(leadCol, "dovrebbe esistere colonna lead");
    assert.ok(leadCol.items.length >= 1);

    const propostaCol = data.board.find(c => c.key === "proposta");
    assert.ok(propostaCol, "dovrebbe esistere colonna proposta");
    assert.ok(propostaCol.items.length >= 1);
  });

  test("PUT /opportunities/:id/move — sposta opportunità in nuovo stage", async () => {
    // Trova un'opportunità in stage 'lead'
    const boardRes = await fetch(`${baseUrl}/v1/opportunities/board`, { headers: auth() });
    const boardData = await boardRes.json();
    const leadCol = boardData.board.find(c => c.key === "lead");
    if (!leadCol || !leadCol.items.length) return; // skip se non ci sono

    const opp = leadCol.items[0];
    const res = await fetch(`${baseUrl}/v1/opportunities/${opp.id}/move`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "contattato" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.opportunity);
    assert.equal(data.opportunity.stage, "contattato");
  });

  test("PUT /opportunities/:id/move — sposta su vinto → status diventa won", async () => {
    const boardRes = await fetch(`${baseUrl}/v1/opportunities/board`, { headers: auth() });
    const boardData = await boardRes.json();
    const leadCol = boardData.board.find(c => c.key === "lead");
    if (!leadCol || !leadCol.items.length) return;

    const opp = leadCol.items[0];
    const res = await fetch(`${baseUrl}/v1/opportunities/${opp.id}/move`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "vinto" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.opportunity.status, "won");
  });

  // ── Contact Merge ─────────────────────────────────────────────────

  test("POST /contacts/merge — unisce due contatti", async () => {
    const res = await postJson(`${baseUrl}/v1/contacts/merge`, {
      sourceEmail: contactEmailSrc,
      intoEmail: contactEmailDst,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.merged, 1);
    assert.equal(data.into_email, contactEmailDst);
  });

  test("POST /contacts/merge — sorgente inesistente (idempotente)", async () => {
    const fake = `fake-${crypto.randomBytes(4).toString("hex")}@example.test`;
    const res = await postJson(`${baseUrl}/v1/contacts/merge`, {
      sourceEmail: fake,
      intoEmail: contactEmailDst,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.merged, 0);
  });

  test("POST /contacts/merge — 400 senza email", async () => {
    const res = await postJson(`${baseUrl}/v1/contacts/merge`, { sourceEmail: "", intoEmail: "" });
    assert.equal(res.status, 400);
  });

  test("POST /contacts/merge — dopo merge, destinazione ha tags uniti", async () => {
    const res = await query(
      "SELECT tags FROM contacts WHERE site_id = $1 AND email = $2",
      [site.id, contactEmailDst]
    );
    const tags = res.rows[0]?.tags || [];
    assert.ok(tags.includes("tag_a"), "tag_a da sorgente");
    assert.ok(tags.includes("tag_b"), "tag_b comune");
    assert.ok(tags.includes("tag_c"), "tag_c da destinazione");
  });
});