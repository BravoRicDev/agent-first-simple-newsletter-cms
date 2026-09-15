import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, uniqueEmail, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerAgentRuntimeRoutes } from "../src/routes/agent-runtime.js";
import config from "../src/config.js";

// Feature 29 — Runtime conversazionale per canale (agente che risponde su
// WhatsApp/email/chat con regole per contatto, rispettando le preferenze
// GDPR). Il canale whatsapp NON viene inviato dal CMS: il runtime scrive
// solo il messaggio OUT nel registro conversazioni.
// NB: NON importa agentRouter — monta agent-runtime.js su un router locale
// con requireAuth + requireAgent, come farebbe il mount reale in agent.js.
describe("agent: runtime conversazionale per canale (feature 29)", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    config.llmApiKey = "";
    site = await createTestSite("Agent Runtime Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "agent runtime test", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    const router = express.Router();
    router.use("/api/agent", requireAuth, requireAgent);
    registerAgentRuntimeRoutes(router);
    app.use(router);
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
  const post = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Crea un contatto con preferenze esplicite (pref_whatsapp default false
  // in DB: i test whatsapp che si aspettano una risposta lo mettono a true).
  async function createContact(email, { prefWhatsapp = false, tags = [] } = {}) {
    await query(
      `INSERT INTO contacts (site_id, email, tags, pref_whatsapp)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id, email) DO UPDATE SET pref_whatsapp = $4, tags = $3`,
      [site.id, email, tags, prefWhatsapp]
    );
  }

  async function getThread(email, channel = "whatsapp") {
    const convs = (await query(
      "SELECT * FROM conversations WHERE site_id = $1 AND contact_email = $2 AND channel = $3",
      [site.id, email, channel]
    )).rows;
    const messages = convs.length
      ? (await query(
        "SELECT direction, body FROM conversation_messages WHERE conversation_id = $1 ORDER BY id ASC",
        [convs[0].id]
      )).rows
      : [];
    return { conversations: convs, messages };
  }

  async function disableAllRuntimes(channel) {
    await query(
      "UPDATE agent_runtimes SET enabled = false WHERE site_id = $1 AND channel = $2",
      [site.id, channel]
    );
  }

  // ── (a) CRUD ──────────────────────────────────────────────────────────
  test("CRUD runtime + sanitizzazione (channel/regex invalidi → 400)", async () => {
    const createRes = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "Assistente WhatsApp",
      channel: "whatsapp",
      enabled: true,
      match: {},
      rules: [
        {
          when: { type: "contains", text: "preventivo" },
          reply: {
            text: "Certo, ti invio il preventivo.",
            actions: [{ type: "add_tag", config: { tag: "preventivo_richiesto" } }],
          },
        },
      ],
      fallback_text: "Non ho capito, puoi ripetere?",
      llm_prompt: "",
    });
    assert.equal(createRes.status, 200);
    const { runtime } = await createRes.json();
    assert.ok(runtime.id);
    assert.equal(runtime.channel, "whatsapp");
    assert.equal(runtime.rules.length, 1);
    assert.equal(runtime.rules[0].reply.actions[0].type, "add_tag");
    const runtimeId = runtime.id;

    // Channel fuori whitelist → 400.
    const badChannel = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "Bad", channel: "telegram", rules: [],
    });
    assert.equal(badChannel.status, 400);

    // Regex invalida → 400.
    const badRegex = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "Bad regex", channel: "email",
      rules: [{ when: { type: "regex", text: "([unclosed" }, reply: { text: "x" } }],
    });
    assert.equal(badRegex.status, 400);

    // Lista.
    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/agent-runtimes`, { headers: auth() });
    assert.equal(listRes.status, 200);
    const { runtimes } = await listRes.json();
    assert.ok(runtimes.some(r => r.id === runtimeId));

    // Update parziale (solo nome + disabilita).
    const putRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/agent-runtimes/${runtimeId}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Assistente WhatsApp v2", enabled: false }),
    });
    assert.equal(putRes.status, 200);
    const { runtime: updated } = await putRes.json();
    assert.equal(updated.name, "Assistente WhatsApp v2");
    assert.equal(updated.enabled, false);
    assert.equal(updated.rules.length, 1, "regole conservate nel merge parziale");

    // Delete.
    const delRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/agent-runtimes/${runtimeId}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(delRes.status, 200);
    const after = await fetch(`${baseUrl}/api/agent/sites/${site.id}/agent-runtimes`, { headers: auth() });
    assert.ok(!(await after.json()).runtimes.some(r => r.id === runtimeId));
  });

  // ── (b) process: regola contains matcha → risposta + OUT + azione ─────
  test("process: regola contains matcha → handled, reply, messaggio OUT e tag applicato", async () => {
    await disableAllRuntimes("whatsapp");
    const email = uniqueEmail("runtime-b");
    await createContact(email, { prefWhatsapp: true });

    const createRes = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "WhatsApp Sales",
      channel: "whatsapp",
      rules: [
        {
          when: { type: "contains", text: "preventivo" },
          reply: {
            text: "Certo, ti invio il preventivo domani mattina.",
            actions: [{ type: "add_tag", config: { tag: "preventivo_richiesto" } }],
          },
        },
      ],
      fallback_text: "Non ho capito.",
    });
    const { runtime } = await createRes.json();
    assert.ok(runtime.id);

    const res = await post(`/api/agent/sites/${site.id}/agent-runtime/process`, {
      channel: "whatsapp",
      contact_email: email,
      message: "Buongiorno, mi serve un preventivo per il sito vetrina",
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.handled, true);
    assert.equal(result.reply, "Certo, ti invio il preventivo domani mattina.");
    assert.equal(result.matched_rule_index, 0);
    assert.ok(result.conversation_id);

    // Messaggio OUT presente nel thread (registro conversazioni).
    const { conversations, messages } = await getThread(email, "whatsapp");
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].channel, "whatsapp");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].direction, "out");
    assert.equal(messages[0].body, "Certo, ti invio il preventivo domani mattina.");

    // Azione add_tag applicata.
    const contact = (await query(
      "SELECT tags FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email]
    )).rows[0];
    assert.ok(contact.tags.includes("preventivo_richiesto"));
  });

  // ── (c) nessuna regola matcha → fallback_text ─────────────────────────
  test("process: nessuna regola matcha → fallback_text", async () => {
    await disableAllRuntimes("whatsapp");
    const email = uniqueEmail("runtime-c");
    await createContact(email, { prefWhatsapp: true });

    const createRes = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "WhatsApp Fallback",
      channel: "whatsapp",
      rules: [{ when: { type: "contains", text: "preventivo" }, reply: { text: "Certo." } }],
      fallback_text: "Non ho capito, puoi ripetere?",
    });
    const { runtime } = await createRes.json();
    assert.ok(runtime.id);

    const res = await post(`/api/agent/sites/${site.id}/agent-runtime/process`, {
      channel: "whatsapp",
      contact_email: email,
      message: "Buongiorno",
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.handled, true);
    assert.equal(result.matched_rule_index, -1);
    assert.equal(result.reply, "Non ho capito, puoi ripetere?");

    const { messages } = await getThread(email, "whatsapp");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, "Non ho capito, puoi ripetere?");
  });

  // ── (d) nessun runtime attivo per il canale → handled:false ───────────
  test("process: nessun runtime attivo per il canale → handled:false, nessun messaggio", async () => {
    const email = uniqueEmail("runtime-d");
    await createContact(email, { prefWhatsapp: true });

    // Canale 'chat': non è mai stato creato un runtime chat → nessun match.
    const res = await post(`/api/agent/sites/${site.id}/agent-runtime/process`, {
      channel: "chat",
      contact_email: email,
      message: "Ciao",
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.handled, false);

    const { conversations, messages } = await getThread(email, "email");
    assert.equal(conversations.length, 0);
    assert.equal(messages.length, 0);
  });

  // ── (e) preferenze GDPR: pref_whatsapp=false → skipped:pref ───────────
  test("process: pref_whatsapp=false → skipped:'pref' e NESSUN messaggio OUT", async () => {
    await disableAllRuntimes("whatsapp");
    const email = uniqueEmail("runtime-e");
    // pref_whatsapp resta false (default) — contatto NON consenziente.
    await createContact(email, { prefWhatsapp: false });

    const createRes = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "WhatsApp GDPR",
      channel: "whatsapp",
      rules: [{ when: { type: "contains", text: "preventivo" }, reply: { text: "Certo." } }],
      fallback_text: "Non ho capito.",
    });
    assert.equal(createRes.status, 200);

    const res = await post(`/api/agent/sites/${site.id}/agent-runtime/process`, {
      channel: "whatsapp",
      contact_email: email,
      // Il messaggio matcha la regola: se risponde comunque, il check GDPR è rotto.
      message: "Mi serve un preventivo",
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.handled, true);
    assert.equal(result.skipped, "pref");

    // Nessun messaggio OUT, nessuna conversazione creata.
    const { conversations, messages } = await getThread(email, "whatsapp");
    assert.equal(conversations.length, 0);
    assert.equal(messages.length, 0);
  });

  // ── (f) testRuntime: dry-run senza side-effect ─────────────────────────
  test("testRuntime: dry-run → matched_rule_index/reply/would_actions, zero side-effect", async () => {
    const email = uniqueEmail("runtime-f");
    await createContact(email, { prefWhatsapp: true, tags: [] });

    const createRes = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "Runtime Test Dry",
      channel: "whatsapp",
      rules: [
        {
          when: { type: "starts", text: "ciao" },
          reply: {
            text: "Ciao! Come posso aiutarti?",
            actions: [
              { type: "add_tag", config: { tag: "salutato" } },
              { type: "create_task", config: { title: "Chiamare il lead", notes: "da testRuntime" } },
            ],
          },
        },
      ],
      fallback_text: "Non ho capito.",
    });
    const { runtime } = await createRes.json();
    assert.ok(runtime.id);

    const res = await post(`/api/agent/sites/${site.id}/agent-runtimes/${runtime.id}/test`, {
      message: "ciao, come funziona?",
      contact_email: email,
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.matched, true);
    assert.equal(result.matched_rule_index, 0);
    assert.equal(result.reply, "Ciao! Come posso aiutarti?");
    assert.equal(result.would_actions.length, 2);
    assert.equal(result.would_actions[0].type, "add_tag");

    // Zero side-effect: nessun messaggio, nessuna conversazione, nessun tag.
    const { conversations, messages } = await getThread(email, "whatsapp");
    assert.equal(conversations.length, 0);
    assert.equal(messages.length, 0);
    const contact = (await query(
      "SELECT tags FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email]
    )).rows[0];
    assert.deepEqual(contact.tags, []);
    const tasks = (await query(
      "SELECT id FROM tasks WHERE site_id = $1 AND email = $2", [site.id, email]
    )).rows;
    assert.equal(tasks.length, 0);
  });

  // ── (g) match contact_email esatto → risponde solo a quel contatto ────
  test("process: match.contact_email esatto → risponde solo a quel contatto", async () => {
    await disableAllRuntimes("whatsapp");
    const targetEmail = uniqueEmail("runtime-g-target");
    const otherEmail = uniqueEmail("runtime-g-other");
    await createContact(targetEmail, { prefWhatsapp: true });
    await createContact(otherEmail, { prefWhatsapp: true });

    const createRes = await post(`/api/agent/sites/${site.id}/agent-runtimes`, {
      name: "Runtime Solo Target",
      channel: "whatsapp",
      match: { contact_email: targetEmail },
      rules: [{ when: { type: "contains", text: "ciao" }, reply: { text: "Ciao! Ti rispondo io." } }],
      fallback_text: "Non ho capito.",
    });
    const { runtime } = await createRes.json();
    assert.ok(runtime.id);

    // Altro contatto: il runtime NON si applica → handled:false.
    const otherRes = await post(`/api/agent/sites/${site.id}/agent-runtime/process`, {
      channel: "whatsapp",
      contact_email: otherEmail,
      message: "ciao",
    });
    assert.equal(otherRes.status, 200);
    assert.equal((await otherRes.json()).handled, false);

    // Contatto target: risposta.
    const targetRes = await post(`/api/agent/sites/${site.id}/agent-runtime/process`, {
      channel: "whatsapp",
      contact_email: targetEmail,
      message: "ciao",
    });
    assert.equal(targetRes.status, 200);
    const result = await targetRes.json();
    assert.equal(result.handled, true);
    assert.equal(result.reply, "Ciao! Ti rispondo io.");
  });
});
