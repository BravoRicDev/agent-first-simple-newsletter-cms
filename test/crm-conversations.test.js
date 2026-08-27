import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// Note lead (timeline) + conversazioni email/WhatsApp (thread + messaggi).
// Il canale whatsapp NON viene inviato dal CMS: registra messaggi in/out
// che arrivano da un bot esterno (Baileys) via API agente/MCP.
describe("crm: note lead + conversazioni email/whatsapp", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Conversations Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm conv", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
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

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const email = "lead.conv@example.test";

  // ── Note ───────────────────────────────────────────────────────────────
  // Gli eventi (note_added, conversation_*) sono emessi fire-and-forget:
  // il test fa polling breve invece di assumere sincronia.
  async function waitForEvent(eventType, predicate = () => true, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = (await query(
        "SELECT event_type, payload FROM contact_events WHERE site_id = $1 AND email = $2 AND event_type = $3 ORDER BY id DESC LIMIT 5",
        [site.id, email, eventType]
      )).rows;
      if (rows.some(predicate)) return rows[0];
      await new Promise(r => setTimeout(r, 25));
    }
    return null;
  }

  test("note: aggiungi + lista + evento generato", async () => {
    const addRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/notes`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Ha chiesto il preventivo per il sito vetrina", author_type: "agent", author_name: "Hermes" }),
    });
    assert.equal(addRes.status, 200);
    const { note } = await addRes.json();
    assert.ok(note.id);
    assert.equal(note.author_type, "agent");
    assert.equal(note.author_name, "Hermes");

    const addRes2 = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/notes`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Richiamare giovedì", author_type: "human" }),
    });
    assert.equal(addRes2.status, 200);

    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/notes`, { headers: auth() });
    const { notes } = await listRes.json();
    assert.equal(notes.length, 2);
    assert.equal(notes[0].body, "Richiamare giovedì", "ordinamento: più recente prima");

    // L'evento note_added alimenta workflow/scoring/segmenti.
    const ev = await waitForEvent("note_added", e => e.payload?.author_type === "human");
    assert.ok(ev, "evento note_added generato");
    assert.equal(ev.payload.author_type, "human");
  });

  test("note: delete", async () => {
    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/notes`, { headers: auth() });
    const { notes } = await listRes.json();
    const delRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/notes/${notes[0].id}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(delRes.status, 200);
    const after = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/notes`, { headers: auth() });
    assert.equal((await after.json()).notes.length, 1);
  });

  test("note: body vuoto → 400", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/notes`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "" }),
    });
    assert.equal(res.status, 400);
  });

  // ── Conversazioni email ────────────────────────────────────────────────
  test("conversazione email: messaggio out crea thread + inbox messaggio", async () => {
    const outRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/conversations/email/messages`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "out", subject: "Il tuo preventivo", body: "Ecco il preventivo come promesso.", meta: { campaign_id: 7 } }),
    });
    assert.equal(outRes.status, 200);
    const { message } = await outRes.json();
    assert.ok(message.conversation_id);
    assert.equal(message.direction, "out");
    assert.equal(message.meta.campaign_id, 7);

    // Stessa conversazione: secondo messaggio inbound (risposta del lead).
    const inRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/conversations/email/messages`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "in", subject: "Re: Il tuo preventivo", body: "Va bene, partiamo!" }),
    });
    assert.equal(inRes.status, 200);
    const inMsg = (await inRes.json()).message;
    assert.equal(inMsg.conversation_id, message.conversation_id, "stesso thread");

    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?email=${email}`, { headers: auth() });
    const { conversations } = await listRes.json();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].channel, "email");
    assert.equal(conversations[0].status, "open");
    assert.equal(conversations[0].messages_count, 2);
    assert.equal(conversations[0].last_subject, "Re: Il tuo preventivo");
  });

  test("conversazione: messaggi del thread in ordine cronologico", async () => {
    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?email=${email}`, { headers: auth() });
    const { conversations } = await listRes.json();
    const threadRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations/${conversations[0].id}/messages`, { headers: auth() });
    const { conversation, messages } = await threadRes.json();
    assert.equal(conversation.id, conversations[0].id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].direction, "out", "primo messaggio = out");
    assert.equal(messages[1].direction, "in", "secondo messaggio = in");
  });

  test("conversazione: cambio stato + evento generato", async () => {
    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?email=${email}`, { headers: auth() });
    const { conversations } = await listRes.json();
    const patchRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations/${conversations[0].id}`, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    assert.equal(patchRes.status, 200);
    const { conversation } = await patchRes.json();
    assert.equal(conversation.status, "closed");

    const ev = await waitForEvent("conversation_status_changed", e => e.payload?.to_status === "closed");
    assert.ok(ev, "evento conversation_status_changed generato");
    assert.equal(ev.payload.to_status, "closed");
  });

  test("conversazione: filtro status", async () => {
    const openRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?status=open`, { headers: auth() });
    assert.equal((await openRes.json()).conversations.length, 0, "chiusa non appare tra le aperte");
    const closedRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?status=closed`, { headers: auth() });
    assert.equal((await closedRes.json()).conversations.length, 1);
  });

  // ── Conversazioni WhatsApp (canale esterno, nessun invio dal CMS) ─────
  test("whatsapp: registra messaggi in/out via API (il bot Baileys invia)", async () => {
    const outRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/conversations/whatsapp/messages`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "out", body: "Ciao! Ti mando il preventivo su WhatsApp.", meta: { wa_message_id: "ABC123" } }),
    });
    assert.equal(outRes.status, 200);
    const outMsg = (await outRes.json()).message;
    assert.equal(outMsg.meta.wa_message_id, "ABC123");

    const inRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/conversations/whatsapp/messages`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "in", body: "Perfetto, grazie!" }),
    });
    assert.equal(inRes.status, 200);

    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?email=${email}`, { headers: auth() });
    const { conversations } = await listRes.json();
    const wa = conversations.find(c => c.channel === "whatsapp");
    assert.ok(wa, "thread whatsapp creato");
    assert.equal(wa.messages_count, 2);

    const threadRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations/${wa.id}/messages`, { headers: auth() });
    const { messages } = await threadRes.json();
    assert.equal(messages[0].direction, "out");
    assert.equal(messages[1].direction, "in");
  });

  test("whatsapp: canale non valido → 400", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/${email}/conversations/sms/messages`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "test" }),
    });
    assert.equal(res.status, 400);
  });

  // ── GDPR ───────────────────────────────────────────────────────────────
  test("GDPR: export include note e conversazioni", async () => {
    const { exportContactData } = await import("../src/services/privacy.js");
    const data = await exportContactData(site.id, email);
    assert.ok(data.notes.length >= 1, "note nell'export");
    assert.equal(data.conversations.length, 2, "thread email + whatsapp");
    const emailThread = data.conversations.find(c => c.channel === "email");
    assert.equal(emailThread.messages.length, 2);
  });

  test("GDPR: erase elimina anche note e conversazioni", async () => {
    const { eraseContactData } = await import("../src/services/privacy.js");
    const result = await eraseContactData(site.id, email);
    assert.ok(result.notes >= 1);
    assert.equal(result.conversations, 2);
    const notes = (await query("SELECT COUNT(*)::int AS c FROM contact_notes WHERE site_id = $1 AND contact_email = $2", [site.id, email])).rows[0].c;
    const convs = (await query("SELECT COUNT(*)::int AS c FROM conversations WHERE site_id = $1 AND contact_email = $2", [site.id, email])).rows[0].c;
    const msgs = (await query(
      "SELECT COUNT(*)::int AS c FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = $1 AND c.contact_email = $2",
      [site.id, email]
    )).rows[0].c;
    assert.equal(notes, 0);
    assert.equal(convs, 0);
    assert.equal(msgs, 0, "messaggi eliminati via cascade");
  });

  // ── Delete conversazione ───────────────────────────────────────────────
  test("conversazione: delete elimina thread e messaggi", async () => {
    const { addConversationMessage } = await import("../src/services/conversations.js");
    await addConversationMessage(site.id, "del.conv@example.test", "email", { body: "solo per delete" });
    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?email=del.conv@example.test`, { headers: auth() });
    const { conversations } = await listRes.json();
    assert.equal(conversations.length, 1);

    const delRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations/${conversations[0].id}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(delRes.status, 200);
    const after = await fetch(`${baseUrl}/api/agent/sites/${site.id}/conversations?email=del.conv@example.test`, { headers: auth() });
    assert.equal((await after.json()).conversations.length, 0);
  });
});
