import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import v1Routes from "../src/routes/v1.js";
import { query } from "../src/db.js";
import { closeDb, createTestSite } from "./helpers.js";

// ONDA 2 Phase 5 — Conversazioni outbound: surface /v1 per thread di
// conversazione email/whatsapp (API compatibili con CRM diffusi).
// Tutte le route passano da requireTenant(): header Location-Id + Bearer.
describe("ONDA 2 — v1 conversations outbound", () => {
  let server, baseUrl;
  let siteA, siteB;

  before(async () => {
    siteA = await createTestSite("Conv Site A");
    siteB = await createTestSite("Conv Site B");

    // Crea API key per i due tenant (token in chiaro salvato, hash in DB)
    const rawA = "test-key-conv-a-" + crypto.randomBytes(8).toString("hex");
    const hashA = crypto.createHash("sha256").update(rawA).digest("hex");
    await query(
      `INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active)
       VALUES ($1, $2, $3, $4, true)`,
      [siteA.id, "conv-test-a", hashA, rawA.slice(0, 16)]
    );

    const rawB = "test-key-conv-b-" + crypto.randomBytes(8).toString("hex");
    const hashB = crypto.createHash("sha256").update(rawB).digest("hex");
    await query(
      `INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active)
       VALUES ($1, $2, $3, $4, true)`,
      [siteB.id, "conv-test-b", hashB, rawB.slice(0, 16)]
    );

    const app = express();
    app.use(express.json());
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      console.error("TEST ERROR:", err.message, err.stack?.slice(0, 300));
      res.status(err.statusCode || 500).json({ error: err.message });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });

    // Esponi token per i test
    server._tokenA = rawA;
    server._tokenB = rawB;
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  function authA() {
    return { "Location-Id": String(siteA.id), Authorization: `Bearer ${server._tokenA}` };
  }
  function authB() {
    return { "Location-Id": String(siteB.id), Authorization: `Bearer ${server._tokenB}` };
  }

  // helper: crea una conversazione via query diretta per i test
  async function insertConversation(siteId, email, channel = "email", status = "open", subject = "") {
    const row = (await query(
      `INSERT INTO conversations (site_id, contact_email, channel, status, subject)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [siteId, email, channel, status, subject]
    )).rows[0];
    return row;
  }

  async function insertMessage(conversationId, direction = "out", subject = "", body = "") {
    const row = (await query(
      `INSERT INTO conversation_messages (conversation_id, direction, subject, body)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [conversationId, direction, subject, body]
    )).rows[0];
    return row;
  }

  // ── Test ──────────────────────────────────────────────────────────────

  test("GET /v1/conversations → 200 lista vuota", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations`, { headers: authA() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.conversations));
    assert.equal(data.conversations.length, 0);
    assert.equal(data.total, 0);
  });

  test("GET /v1/conversations → 200 con dati dopo inserimento", async () => {
    const email = "lead@test-a.com";
    await insertConversation(siteA.id, email, "email", "open", "Richiesta preventivo");

    const res = await fetch(`${baseUrl}/v1/conversations`, { headers: authA() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.conversations.length, 1);
    assert.equal(data.conversations[0].contact_email, email);
    assert.equal(data.conversations[0].channel, "email");
    assert.equal(data.conversations[0].status, "open");
    assert.ok(data.total >= 1);
  });

  test("GET /v1/conversations/:id → dettaglio conversazione", async () => {
    const email = "detail@test-a.com";
    const conv = await insertConversation(siteA.id, email, "email", "open", "Dettaglio test");

    const res = await fetch(`${baseUrl}/v1/conversations/${conv.id}`, { headers: authA() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.conversation.id, conv.id);
    assert.equal(data.conversation.contact_email, email);
    assert.equal(data.conversation.subject, "Dettaglio test");
  });

  test("GET /v1/conversations/:id → 404 per id inesistente", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/999999`, { headers: authA() });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
  });

  test("GET /v1/conversations/:id/messages → lista messaggi", async () => {
    const email = "messages@test-a.com";
    const conv = await insertConversation(siteA.id, email, "email", "open", "Thread messaggi");
    await insertMessage(conv.id, "out", "Il tuo preventivo", "Ecco il preventivo come promesso.");
    await insertMessage(conv.id, "in", "Re: Il tuo preventivo", "Va bene, partiamo!");

    const res = await fetch(`${baseUrl}/v1/conversations/${conv.id}/messages`, { headers: authA() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.conversation.id, conv.id);
    assert.equal(data.messages.length, 2);
    assert.equal(data.messages[0].direction, "out");
    assert.equal(data.messages[1].direction, "in");
  });

  test("POST /v1/conversations/:id/messages → aggiunge messaggio outbound", async () => {
    const email = "addmsg@test-a.com";
    const conv = await insertConversation(siteA.id, email, "email", "open", "Add msg");

    const res = await fetch(`${baseUrl}/v1/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { ...authA(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "out", subject: "Follow-up", body: "Richiamiamo il lead." }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.message.direction, "out");
    assert.equal(data.message.subject, "Follow-up");
    assert.equal(data.message.body, "Richiamiamo il lead.");
    assert.ok(data.message.conversation_id || data.message.id);
  });

  test("POST /v1/conversations/:id/messages → 404 per conversazione inesistente", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/999999/messages`, {
      method: "POST",
      headers: { ...authA(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "test" }),
    });
    assert.equal(res.status, 404);
  });

  test("PUT /v1/conversations/:id/status → cambia status", async () => {
    const email = "status@test-a.com";
    const conv = await insertConversation(siteA.id, email, "email", "open", "Status test");

    const res = await fetch(`${baseUrl}/v1/conversations/${conv.id}/status`, {
      method: "PUT",
      headers: { ...authA(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.conversation.status, "closed");
  });

  test("PUT /v1/conversations/:id/status → 400 per status non valido", async () => {
    const email = "badstatus@test-a.com";
    const conv = await insertConversation(siteA.id, email, "email", "open");

    const res = await fetch(`${baseUrl}/v1/conversations/${conv.id}/status`, {
      method: "PUT",
      headers: { ...authA(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid" }),
    });
    assert.equal(res.status, 400);
  });

  test("GET /v1/conversations?status=closed → filtro funziona", async () => {
    const email = "filter@test-a.com";
    await insertConversation(siteA.id, email, "email", "open", "Aperta");
    await insertConversation(siteA.id, "filter2@test-a.com", "whatsapp", "closed", "Chiusa");

    // Solo closed
    const res = await fetch(`${baseUrl}/v1/conversations?status=closed`, { headers: authA() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.conversations.every((c) => c.status === "closed"), "tutte chiuse");
  });

  test("DELETE /v1/conversations/:id → elimina conversazione", async () => {
    const email = "delete@test-a.com";
    const conv = await insertConversation(siteA.id, email, "email", "open", "Da eliminare");

    const delRes = await fetch(`${baseUrl}/v1/conversations/${conv.id}`, {
      method: "DELETE",
      headers: authA(),
    });
    assert.equal(delRes.status, 200);
    const data = await delRes.json();
    assert.equal(data.deleted, true);
    assert.equal(data.id, conv.id);

    // Verifica 404 dopo delete
    const getRes = await fetch(`${baseUrl}/v1/conversations/${conv.id}`, { headers: authA() });
    assert.equal(getRes.status, 404);
  });

  test("Isolamento tenant: siteB non vede conversazioni di siteA", async () => {
    // siteA ha conversazioni dai test precedenti
    const resA = await fetch(`${baseUrl}/v1/conversations`, { headers: authA() });
    const dataA = await resA.json();
    assert.ok(dataA.total > 0, "siteA ha conversazioni");

    const resB = await fetch(`${baseUrl}/v1/conversations`, { headers: authB() });
    const dataB = await resB.json();
    assert.equal(dataB.total, 0, "siteB non vede conversazioni di siteA");
  });

  test("GET /v1/conversations?email=... → filtro email", async () => {
    const email = "email-filter@test-a.com";
    await insertConversation(siteA.id, email, "email", "open");

    const res = await fetch(`${baseUrl}/v1/conversations?email=${encodeURIComponent(email)}`, { headers: authA() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.conversations.length >= 1);
    assert.equal(data.conversations[0].contact_email, email);
  });

  test("GET /v1/conversations?channel=whatsapp → filtro canale", async () => {
    const email = "wa-filter@test-a.com";
    await insertConversation(siteA.id, email, "whatsapp", "open", "WA test");

    const res = await fetch(`${baseUrl}/v1/conversations?channel=whatsapp`, { headers: authA() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.conversations.every((c) => c.channel === "whatsapp"), "solo whatsapp");
  });
});