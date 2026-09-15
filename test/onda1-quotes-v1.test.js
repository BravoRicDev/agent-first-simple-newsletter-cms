import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 1 — Preventivi / Quotes sulla surface /v1 (CRUD/status/PDF/isolamento
// tenant).
describe("ONDA 1 — quotes API /v1", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;
  let contactEmailA;
  let oppIdA;

  before(async () => {
    siteA = await createTestSite("Q1 Tenant A");
    siteB = await createTestSite("Q1 Tenant B");

    const mk = async (siteId, name) => {
      const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const r = await query(
        "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
        [siteId, name, hash, raw.slice(0, 12)]
      );
      return { id: r.rows[0].id, raw };
    };
    apiKeyA = await mk(siteA.id, "key A");
    apiKeyB = await mk(siteB.id, "key B");

    // Crea un contatto + opportunità per testare quote con opportunity_id
    contactEmailA = `quote-contact-${crypto.randomBytes(4).toString("hex")}@example.test`;
    await query(
      "INSERT INTO contacts (site_id, email) VALUES ($1, $2)",
      [siteA.id, contactEmailA]
    );
    const opp = await query(
      `INSERT INTO opportunities (site_id, contact_email, title, stage, status)
       VALUES ($1, $2, 'Opportunità test quote', 'lead', 'open') RETURNING id`,
      [siteA.id, contactEmailA]
    );
    oppIdA = opp.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: err.message });
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

  const auth = (tenant, key) => ({
    "Location-Id": String(tenant),
    Authorization: `Bearer ${key}`,
    Version: "2017-04-19",
  });
  const postJson = (url, body, headers = {}) => fetch(url, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const putJson = (url, body, headers = {}) => fetch(url, {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  test("401 senza credenziali", async () => {
    const res = await fetch(`${baseUrl}/v1/quotes`);
    assert.equal(res.status, 401);
  });

  test("POST /quotes — crea preventivo senza opportunity", async () => {
    const res = await postJson(`${baseUrl}/v1/quotes`, {
      contactEmail: contactEmailA,
      title: "Preventivo Test",
      items: [
        { description: "Consulenza", qty: 10, price: 50 },
        { description: "Setup", qty: 1, price: 200 },
      ],
      notes: "Offerta valida 30 gg",
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.quote);
    assert.equal(data.quote.contact_email, contactEmailA);
    assert.equal(data.quote.title, "Preventivo Test");
    assert.ok(data.quote.quote_number);
    assert.ok(data.quote.quote_number.startsWith("Q-"));
    assert.ok(data.quote.token, "deve avere token pubblico");
    assert.equal(data.quote.total, 700); // 10*50 + 1*200
    assert.equal(data.quote.status, "draft");
  });

  test("POST /quotes — crea preventivo con opportunity", async () => {
    const res = await postJson(`${baseUrl}/v1/quotes`, {
      contactEmail: contactEmailA,
      opportunityId: oppIdA,
      title: "Preventivo con Opp",
      items: [{ description: "Sviluppo", qty: 1, price: 1500 }],
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.quote.opportunity_id, oppIdA);
    assert.equal(data.quote.total, 1500);
  });

  test("POST /quotes — 400 senza contactEmail", async () => {
    const res = await postJson(`${baseUrl}/v1/quotes`, { title: "No email" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 400);
  });

  test("GET /quotes — lista preventivi", async () => {
    const res = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.quotes));
    assert.ok(data.quotes.length >= 2);
    assert.ok(data.total >= 2);
  });

  test("GET /quotes/:id — dettaglio preventivo", async () => {
    const list = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteA.id, apiKeyA.raw) });
    const listData = await list.json();
    const quoteId = listData.quotes[0].id;

    const res = await fetch(`${baseUrl}/v1/quotes/${quoteId}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.quote.id, quoteId);
    assert.ok(Array.isArray(data.quote.items));
  });

  test("GET /quotes/:id — 404 su id inesistente", async () => {
    const res = await fetch(`${baseUrl}/v1/quotes/999999`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 404);
  });

  test("PUT /quotes/:id — aggiorna preventivo", async () => {
    const list = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteA.id, apiKeyA.raw) });
    const listData = await list.json();
    const quoteId = listData.quotes[0].id;

    const res = await putJson(`${baseUrl}/v1/quotes/${quoteId}`, {
      title: "Preventivo Aggiornato",
      notes: "Nuove note",
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.quote.title, "Preventivo Aggiornato");
    assert.equal(data.quote.notes, "Nuove note");
  });

  test("PUT /quotes/:id/status — draft → sent → viewed → signed", async () => {
    const list = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteA.id, apiKeyA.raw) });
    const listData = await list.json();
    const quoteId = listData.quotes[0].id;

    // sent
    let res = await putJson(`${baseUrl}/v1/quotes/${quoteId}/status`, { status: "sent" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.equal(data.quote.status, "sent");
    assert.ok(data.quote.sent_at);

    // viewed
    res = await putJson(`${baseUrl}/v1/quotes/${quoteId}/status`, { status: "viewed" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    data = await res.json();
    assert.equal(data.quote.status, "viewed");
    assert.ok(data.quote.viewed_at);

    // signed
    res = await putJson(`${baseUrl}/v1/quotes/${quoteId}/status`, { status: "signed" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    data = await res.json();
    assert.equal(data.quote.status, "signed");
    assert.ok(data.quote.signed_at);
  });

  test("PUT /quotes/:id/status — 400 su status non valido", async () => {
    const list = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteA.id, apiKeyA.raw) });
    const listData = await list.json();
    const quoteId = listData.quotes[0].id;

    const res = await putJson(`${baseUrl}/v1/quotes/${quoteId}/status`, { status: "invalid" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 400);
  });

  test("GET /quotes/:id/pdf — genera PDF", async () => {
    const list = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteA.id, apiKeyA.raw) });
    const listData = await list.json();
    const quoteId = listData.quotes[0].id;

    const res = await fetch(`${baseUrl}/v1/quotes/${quoteId}/pdf`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/pdf");
    const buffer = await res.arrayBuffer();
    assert.ok(buffer.byteLength > 100, "PDF deve avere contenuto");
  });

  test("Isolamento tenant — tenant B non vede quote di A", async () => {
    const res = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteB.id, apiKeyB.raw) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.quotes.length, 0);
    assert.equal(data.total, 0);
  });

  test("DELETE /quotes/:id — elimina preventivo", async () => {
    const list = await fetch(`${baseUrl}/v1/quotes`, { headers: auth(siteA.id, apiKeyA.raw) });
    const listData = await list.json();
    const quoteId = listData.quotes[listData.quotes.length - 1].id;

    const res = await fetch(`${baseUrl}/v1/quotes/${quoteId}`, {
      method: "DELETE", headers: auth(siteA.id, apiKeyA.raw),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.deleted, true);

    // Verifica 404 dopo delete
    const getRes = await fetch(`${baseUrl}/v1/quotes/${quoteId}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(getRes.status, 404);
  });
});