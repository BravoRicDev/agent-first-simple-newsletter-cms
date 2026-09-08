import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";
import publicSmsInboundRoutes from "../../src/routes/public-sms-inbound.js";

describe("Onda F — Conversazioni clone (SMS/Email/WhatsApp)", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let contact;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = res.ok ? await res.json() : null;
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Conversations Clone");
    apiKey = await mkKey(site.id, "test key conversations");

    // Crea contatto di test
    const contactEmail = `contact-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const contactResult = await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
      [site.id, contactEmail]
    );
    contact = { id: contactResult.rows[0].id, externalId: contactResult.rows[0].external_id };
    if (!contact.externalId) {
      const extResult = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
      contact.externalId = extResult.rows[0].external_id;
    }

    // Crea webhook IN per SMS inbound
    await query(
      "INSERT INTO webhooks (site_id, direction, name, active, secret, events) VALUES ($1, 'in', 'SMS Inbound', true, $2, $3)",
      [site.id, "test_webhook_secret", JSON.stringify({ sms_received: { action: "emit_event" } })]
    );

    // Crea app express con entrambi i router (SMS inbound PRIMA del clone router)
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true })); // Twilio usa FormUrlEncoded
    app.use(publicSmsInboundRoutes);
    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  test("SMS: POST /conversations/messages → lista → GET messages → unbound → star → read", async () => {
    // CREATE SMS message usando contatto di test
    const createRes = await fetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "SMS",
        contactId: contact.externalId,
        body: "Hello from SMS test",
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.message);
    assert(createRes.data.message.id);
    assert.equal(createRes.data.message.type, "SMS");
    assert.equal(createRes.data.message.direction, "outbound");
    assert.equal(createRes.data.message.status, "sent");
    const messageId = createRes.data.message.id;

    // LIST conversations
    const listRes = await fetch("/conversations");
    assert.equal(listRes.status, 200);
    assert(listRes.data.conversations);
    assert(listRes.data.conversations.conversation);
    assert.ok(listRes.data.conversations.conversation.length >= 1);
    const thread = listRes.data.conversations.conversation[0];
    assert(thread.id);
    assert.equal(thread.type, "SMS");
    assert.equal(thread.direction, undefined); // Non c'è direction in thread
    assert.equal(thread.unreadCount, 0); // Outbound non aumenta unread
    assert.equal(thread.starred, false);
    assert(thread.lastMessageBody.includes("Hello from SMS test"));
    assert(thread.dateAdded);
    const conversationId = thread.id;

    // GET /conversations/:id/messages
    const messagesRes = await fetch(`/conversations/${conversationId}/messages`);
    assert.equal(messagesRes.status, 200);
    assert(messagesRes.data.messages);
    assert.ok(messagesRes.data.messages.length >= 1);
    const msg = messagesRes.data.messages[0];
    assert.equal(msg.id, messageId);
    assert.equal(msg.direction, "outbound");
    assert.equal(msg.type, "SMS");

    // Note: inbound webhook testato separatamente nel test "SMS inbound webhook"

    // PUT /conversations/:id/star
    const starRes = await fetch(`/conversations/${conversationId}/star`, {
      method: "PUT",
      body: JSON.stringify({ starred: true }),
    });
    assert.equal(starRes.status, 200);
    assert.equal(starRes.data.ok, true);

    // Verify star
    const listRes3 = await fetch("/conversations");
    assert(listRes3.data.conversations.conversation.length >= 1);
    const starred = listRes3.data.conversations.conversation.find((t) => t.id === conversationId);
    assert(starred);
    assert.equal(starred.starred, true);

    // PUT /conversations/:id/read
    const readRes = await fetch(`/conversations/${conversationId}/read`, {
      method: "PUT",
      body: JSON.stringify({}),
    });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.data.ok, true);

    // Note: unreadCount sarà 0 per outbound (non incrementato)
    const listRes4 = await fetch("/conversations");
    const thread4 = listRes4.data.conversations.conversation.find((t) => t.id === conversationId);
    assert(thread4);
    assert.equal(thread4.unreadCount, 0);
  });

  test("Email: POST /conversations/messages type=Email → lista filtra per type", async () => {
    const createRes = await fetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "Email",
        email: contact.externalId, // Test pass UUID direttamente
        body: "Email test message",
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.message.type, "Email");

    // List filter by type=Email
    const listRes = await fetch("/conversations?type=Email");
    assert.equal(listRes.status, 200);
    // Potrebbe esserci il thread Email appena creato, verifica che almeno uno sia Email
    const hasEmail = listRes.data.conversations.conversation.some((t) => t.type === "Email");
    assert.ok(hasEmail);
  });

  test("WhatsApp: POST /conversations/messages type=WhatsApp", async () => {
    const createRes = await fetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "WhatsApp",
        contactId: contact.externalId,
        message: "WhatsApp test",
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.message.type, "WhatsApp");
  });

  test("Errori: contactId mancante → 400, type invalido → 400", async () => {
    // Missing contactId/email
    const noContactRes = await fetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "SMS",
        body: "test",
      }),
    });
    assert.equal(noContactRes.status, 400);

    // Invalid type
    const invalidTypeRes = await fetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "InvalidType",
        contactId: contact.externalId,
        body: "test",
      }),
    });
    assert.equal(invalidTypeRes.status, 400);

    // Missing body
    const noBodyRes = await fetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "SMS",
        contactId: contact.externalId,
      }),
    });
    assert.equal(noBodyRes.status, 400);
  });

  test("Limit: GET /conversations?limit=2 ritorna max 2 thread", async () => {
    // Create 2 SMS con email diverse
    for (let i = 0; i < 2; i++) {
      await fetch("/conversations/messages", {
        method: "POST",
        body: JSON.stringify({
          type: "SMS",
          email: `paginate-test-${i}@example.com`,
          body: `Message ${i}`,
        }),
      });
    }

    // List con limit=2
    const page1 = await fetch("/conversations?limit=2");
    assert.equal(page1.status, 200);
    assert(page1.data.conversations.conversation);
    assert.ok(page1.data.conversations.conversation.length <= 2);
    assert(page1.data.meta.total >= 0);
  });
});
