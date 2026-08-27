import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// Workflow a trigger (F2): CRUD + engine trigger→azioni + test dry-run.
describe("crm: workflow a trigger", () => {
  let site, user, server, baseUrl, token, workflowId;

  before(async () => {
    site = await createTestSite("CRM Workflows Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm workflows", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
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

  test("POST /workflows crea workflow con azioni", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/workflows`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Quiz alto punteggio → tag + task",
        trigger_type: "quiz_completed",
        trigger_config: { quiz_slug: "qualifica-lead", min_score: 8 },
        actions: [
          { action_type: "add_tag", action_config: { tag: "lead-caldo" } },
          { action_type: "create_task", action_config: { title: "Chiama il lead", due_in_days: 1 } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.workflow.id);
    assert.equal(body.workflow.trigger_type, "quiz_completed");
    workflowId = body.workflow.id;
  });

  test("trigger con punteggio sotto soglia → nessuna azione", async () => {
    const { emitContactEvent } = await import("../src/services/events.js");
    await emitContactEvent(site.id, "basso@example.test", "quiz_completed", { quiz_slug: "qualifica-lead", points: 2 });
    const runs = (await query("SELECT COUNT(*) AS c FROM workflow_runs WHERE workflow_id = $1", [workflowId])).rows[0];
    assert.equal(parseInt(runs.c, 10), 0, "sotto soglia non deve eseguire nulla");
  });

  test("trigger con punteggio sopra soglia → tag e task creati", async () => {
    const { emitContactEvent } = await import("../src/services/events.js");
    await emitContactEvent(site.id, "alto@example.test", "quiz_completed", { quiz_slug: "qualifica-lead", points: 12 });

    const contact = (await query("SELECT tags FROM contacts WHERE site_id = $1 AND email = 'alto@example.test'", [site.id])).rows[0];
    assert.ok(contact, "il contatto deve esistere (upsert dall'evento)");
    assert.ok(contact.tags.includes("lead-caldo"), `tag attesi: ${JSON.stringify(contact.tags)}`);

    const task = (await query("SELECT title FROM tasks WHERE site_id = $1 AND email = 'alto@example.test'", [site.id])).rows[0];
    assert.ok(task, "la task deve essere creata");
    assert.equal(task.title, "Chiama il lead");

    const runs = (await query("SELECT COUNT(*) AS c FROM workflow_runs WHERE workflow_id = $1", [workflowId])).rows[0];
    assert.equal(parseInt(runs.c, 10), 1, "deve esserci 1 run registrato");
  });

  test("workflows_test dry-run non esegue azioni ma le elenca", async () => {
    const before = (await query("SELECT COUNT(*) AS c FROM tasks WHERE site_id = $1", [site.id])).rows[0];
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/workflows/${workflowId}/test`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.test" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.would_run.length, 2);
    const after = (await query("SELECT COUNT(*) AS c FROM tasks WHERE site_id = $1", [site.id])).rows[0];
    assert.equal(parseInt(after.c, 10), parseInt(before.c, 10), "dry-run non deve creare task");
  });

  test("workflow disattivato → nessuna esecuzione", async () => {
    await query("UPDATE workflows SET active = false WHERE id = $1", [workflowId]);
    const { emitContactEvent } = await import("../src/services/events.js");
    await emitContactEvent(site.id, "disattivato@example.test", "quiz_completed", { quiz_slug: "qualifica-lead", points: 12 });
    const runs = (await query("SELECT COUNT(*) AS c FROM workflow_runs WHERE workflow_id = $1", [workflowId])).rows[0];
    assert.equal(parseInt(runs.c, 10), 1, "nessun nuovo run su workflow disattivato");
  });

  test("workflows_runs elenca le esecuzioni", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/workflows/${workflowId}/runs`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].email, "alto@example.test");
  });

  test("DELETE /workflows/:id elimina", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/workflows/${workflowId}`, { method: "DELETE", headers: auth() });
    assert.equal(res.status, 200);
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/workflows`, { headers: auth() });
    assert.equal((await list.json()).workflows.length, 0);
  });
});
