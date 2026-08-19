import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerAgentBuilderRoutes } from "../src/routes/agent-builder.js";
import config from "../src/config.js";

// Feature 31 — Agent builder visuale + sandbox di test: CRUD definizioni
// (con sanitizzazione config) + test dry-run senza side-effect + storico
// sandbox_runs. Il modulo route è montato su un router LOCALE (niente
// agentRouter): l'auth requireAuth/requireAgent è applicata dal mount.
describe("crm: agent builder + sandbox di test", () => {
  let site, user, server, baseUrl, token;
  let defId;

  before(async () => {
    // Determininismo: niente LLM reale nei test (l'env del container può
    // avere LLM_API_KEY di produzione → il sandbox LLM è lento/flaky).
    config.llmApiKey = "";
    site = await createTestSite("CRM Agent Builder Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "agent builder", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerAgentBuilderRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use((err, req, res, next) => {
      console.error("ERRORE TEST:", err.message);
      res.status(500).json({ error: "Errore interno", details: err.message });
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

  const basePath = (id = site.id) => `${baseUrl}/api/agent/sites/${id}/agent-definitions`;
  const sandboxPath = () => `${baseUrl}/api/agent/sites/${site.id}/sandbox-runs`;

  test("(a) POST crea definizione con config completa", async () => {
    const res = await fetch(`${basePath()}`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Assistente commerciale",
        description: "Risponde ai lead su WhatsApp",
        config: {
          prompt: "Sei un assistente commerciale di esempio.",
          model: "gpt-4o-mini",
          channels: ["whatsapp", "email", "chat"],
          tools_allowed: ["add_tag", "create_task"],
          reply_style: "amichevole e conciso",
          default_reply: "Grazie, ti ricontattiamo a breve.",
          temperature: 0.7,
        },
        sandbox: true,
        active: true,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.definition.id);
    assert.equal(body.definition.name, "Assistente commerciale");
    assert.equal(body.definition.sandbox, true);
    assert.equal(body.definition.config.channels.length, 3);
    assert.equal(body.definition.config.tools_allowed.length, 2);
    defId = body.definition.id;
  });

  test("(a) GET elenca la definizione creata", async () => {
    const res = await fetch(`${basePath()}`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.definitions.length, 1);
    assert.equal(body.definitions[0].id, defId);
  });

  test("(a) GET /:defId restituisce il dettaglio", async () => {
    const res = await fetch(`${basePath()}/${defId}`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.definition.config.prompt, "Sei un assistente commerciale di esempio.");
  });

  test("(a) PUT aggiorna nome e config (merge parziale)", async () => {
    const res = await fetch(`${basePath()}/${defId}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Assistente commerciale v2", active: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.definition.name, "Assistente commerciale v2");
    assert.equal(body.definition.active, false);
    // config non toccata dal merge parziale
    assert.equal(body.definition.config.prompt, "Sei un assistente commerciale di esempio.");
  });

  test("(b) sanitizzazione: temperature 99 clampata a 2 e canali non ammessi filtrati", async () => {
    const res = await fetch(`${basePath()}`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Def con valori sporchi",
        config: {
          temperature: 99,
          channels: ["whatsapp", "telegram", "sms", "ALL"],
          tools_allowed: ["add_tag", 42, " create_task ", ""],
          prompt: "prompt di prova",
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.definition.config.temperature, 2, "99 deve essere clampata a 2");
    assert.deepEqual(body.definition.config.channels, ["whatsapp", "all"], "solo canali whitelist, dedup, lowercase");
    assert.deepEqual(body.definition.config.tools_allowed, ["add_tag", "42", "create_task"], "solo stringhe non vuote");
  });

  test("(c) test sandbox con default_reply: risposta = default_reply e NESSUN side-effect", async () => {
    const contactEmail = "sandbox-test@example.test";
    const res = await fetch(`${basePath()}/${defId}/test`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Ciao, vorrei un preventivo",
        contact_email: contactEmail,
        channel: "whatsapp",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, "Grazie, ti ricontattiamo a breve.");
    assert.equal(body.definition_id, defId);
    assert.ok(body.sandbox_run_id);

    // Nessuna conversazione, task, nota o contatto creato (dry-run puro).
    const conv = (await query("SELECT COUNT(*)::int AS n FROM conversations WHERE site_id = $1 AND contact_email = $2", [site.id, contactEmail])).rows[0].n;
    const msgs = (await query("SELECT COUNT(*)::int AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.site_id = $1 AND c.contact_email = $2", [site.id, contactEmail])).rows[0].n;
    const tasks = (await query("SELECT COUNT(*)::int AS n FROM tasks WHERE site_id = $1 AND email = $2", [site.id, contactEmail])).rows[0].n;
    const notes = (await query("SELECT COUNT(*)::int AS n FROM contact_notes WHERE site_id = $1 AND contact_email = $2", [site.id, contactEmail])).rows[0].n;
    const contact = (await query("SELECT COUNT(*)::int AS n FROM contacts WHERE site_id = $1 AND email = $2", [site.id, contactEmail])).rows[0].n;
    assert.equal(conv, 0, "nessuna conversazione");
    assert.equal(msgs, 0, "nessun messaggio conversazione");
    assert.equal(tasks, 0, "nessuna task");
    assert.equal(notes, 0, "nessuna nota contatto");
    assert.equal(contact, 0, "nessun contatto creato");
  });

  test("(c) test sandbox senza default_reply: risposta template di simulazione", async () => {
    const res = await fetch(`${basePath()}`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agente senza risposta", config: { temperature: 0.5 } }),
    });
    const created = (await res.json()).definition;

    const testRes = await fetch(`${basePath()}/${created.id}/test`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Test template", channel: "chat" }),
    });
    assert.equal(testRes.status, 200);
    const body = await testRes.json();
    assert.equal(body.reply, "[Simulazione] Nessuna risposta configurata per: Test template");
  });

  test("(d) sandbox_runs registrata nello storico", async () => {
    const res = await fetch(`${basePath()}/${defId}/test`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Secondo test", contact_email: "altro@example.test" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sandbox_run_id);

    const runs = await query(
      "SELECT * FROM sandbox_runs WHERE id = $1 AND site_id = $2 AND agent_definition_id = $3",
      [body.sandbox_run_id, site.id, defId]
    );
    assert.equal(runs.rows.length, 1);
    assert.equal(runs.rows[0].kind, "agent_test");
    assert.equal(runs.rows[0].input.message, "Secondo test");
    assert.equal(runs.rows[0].output.reply, "Grazie, ti ricontattiamo a breve.");
    assert.equal(runs.rows[0].output.matched_definition.id, defId);
  });

  test("(e) GET /sandbox-runs elenca con filtro definition_id", async () => {
    const res = await fetch(`${basePath()}/${defId}/test`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Terzo test" }),
    });
    assert.equal(res.status, 200);

    const all = await fetch(`${sandboxPath()}`, { headers: auth() });
    const allBody = await all.json();
    assert.ok(allBody.runs.length >= 3, "almeno 3 run totali");

    const filtered = await fetch(`${sandboxPath()}?definition_id=${defId}`, { headers: auth() });
    const filteredBody = await filtered.json();
    assert.ok(filteredBody.runs.length >= 3, "almeno 3 run per la definizione principale");
    for (const run of filteredBody.runs) {
      assert.equal(run.agent_definition_id, defId);
    }

    const limited = await fetch(`${sandboxPath()}?limit=1`, { headers: auth() });
    assert.equal((await limited.json()).runs.length, 1);
  });

  test("(f) 404 su definizione inesistente (GET e test)", async () => {
    const res = await fetch(`${basePath()}/999999`, { headers: auth() });
    assert.equal(res.status, 404);

    const testRes = await fetch(`${basePath()}/999999/test`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Ciao" }),
    });
    assert.equal(testRes.status, 404);
  });

  test("(a) DELETE elimina la definizione", async () => {
    const res = await fetch(`${basePath()}/${defId}`, { method: "DELETE", headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, defId);

    const list = await fetch(`${basePath()}`, { headers: auth() });
    const listBody = await list.json();
    assert.ok(!listBody.definitions.some(d => d.id === defId));
  });
});
