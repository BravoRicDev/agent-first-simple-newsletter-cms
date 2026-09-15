import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerRecurringRoutes } from "../src/routes/agent-recurring.js";
import { generateDueRecurringTasks, checkFollowups } from "../src/services/recurring.js";

// Feature 27: task ricorrenti + follow-up intelligente ('aspetta risposta →
// se N giorni senza risposta avvisa'). Le route NON sono ancora registrate
// in agent.js → montiamo il modulo su un router locale con la stessa
// catena auth usata in produzione (requireAuth + requireAgent).
describe("crm: task ricorrenti + follow-up intelligente", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Recurring Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "recurring", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerRecurringRoutes(r);
    app.use(r);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
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
  const api = (path, opts = {}) => fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { ...auth(), ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  test("(a) CRUD task ricorrente via API", async () => {
    const res = await api(`/api/agent/sites/${site.id}/recurring-tasks`, {
      method: "POST",
      body: { title: "Chiama lead", notes: "ogni giorno", cadence: "daily" },
    });
    assert.equal(res.status, 200);
    const { recurring_task } = await res.json();
    assert.ok(recurring_task.id);
    assert.equal(recurring_task.cadence, "daily");
    assert.equal(recurring_task.active, true);
    assert.ok(recurring_task.next_due_at, "next_due_at valorizzato di default");

    const list = await api(`/api/agent/sites/${site.id}/recurring-tasks`);
    assert.equal(list.status, 200);
    const { recurring_tasks } = await list.json();
    assert.ok(recurring_tasks.some(t => t.id === recurring_task.id));

    const up = await api(`/api/agent/sites/${site.id}/recurring-tasks/${recurring_task.id}`, {
      method: "PUT",
      body: { title: "Chiama lead (aggiornato)", cadence: "weekly" },
    });
    assert.equal(up.status, 200);
    const { recurring_task: updated } = await up.json();
    assert.equal(updated.title, "Chiama lead (aggiornato)");
    assert.equal(updated.cadence, "weekly");

    const del = await api(`/api/agent/sites/${site.id}/recurring-tasks/${recurring_task.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const afterList = await api(`/api/agent/sites/${site.id}/recurring-tasks`);
    const { recurring_tasks: remaining } = await afterList.json();
    assert.ok(!remaining.some(t => t.id === recurring_task.id));
  });

  test("(b) generateDueRecurringTasks: backdate → genera task e avanza next_due_at", async () => {
    const created = await api(`/api/agent/sites/${site.id}/recurring-tasks`, {
      method: "POST",
      body: { title: "Follow-up settimanale", cadence: "daily" },
    });
    const { recurring_task } = await created.json();

    const past = new Date(Date.now() - 2 * 86400000).toISOString();
    const back = await api(`/api/agent/sites/${site.id}/recurring-tasks/${recurring_task.id}`, {
      method: "PUT",
      body: { next_due_at: past },
    });
    assert.equal(back.status, 200);

    const { generated } = await generateDueRecurringTasks();
    assert.ok(generated >= 1, `generateDueRecurringTasks ha generato ${generated} task`);

    const taskRows = (await query(
      "SELECT * FROM tasks WHERE site_id = $1 AND title = $2",
      [site.id, "Follow-up settimanale"]
    )).rows;
    assert.equal(taskRows.length, 1, "una riga creata in tabella tasks");
    assert.equal(taskRows[0].status, "open");
    assert.equal(taskRows[0].email, "");

    const row = (await query(
      "SELECT * FROM recurring_tasks WHERE id = $1",
      [recurring_task.id]
    )).rows[0];
    assert.ok(row.last_generated_at, "last_generated_at valorizzato");
    assert.ok(new Date(row.next_due_at) > new Date(past), "next_due_at avanzato nel futuro");
    // cadence daily → avanzamento di ~1 giorno dal next_due_at backdatato
    const diffDays = (new Date(row.next_due_at) - new Date(past)) / 86400000;
    assert.ok(diffDays >= 0.9 && diffDays <= 1.1, `avanzamento di ~1 giorno (${diffDays.toFixed(2)})`);
  });

  test("(c) CRUD regola follow-up via API", async () => {
    const res = await api(`/api/agent/sites/${site.id}/followup-rules`, {
      method: "POST",
      body: {
        name: "Nessuna risposta → task",
        wait_days: 3,
        channel: "conversation",
        statuses: ["pending", "open"],
        action_type: "create_task",
        action_config: { title: "Richiama il lead" },
      },
    });
    assert.equal(res.status, 200);
    const { followup_rule } = await res.json();
    assert.ok(followup_rule.id);
    assert.equal(followup_rule.wait_days, 3);
    assert.equal(followup_rule.action_type, "create_task");

    const list = await api(`/api/agent/sites/${site.id}/followup-rules`);
    const { followup_rules } = await list.json();
    assert.ok(followup_rules.some(rule => rule.id === followup_rule.id));

    const up = await api(`/api/agent/sites/${site.id}/followup-rules/${followup_rule.id}`, {
      method: "PUT",
      body: { wait_days: 5 },
    });
    const { followup_rule: updated } = await up.json();
    assert.equal(updated.wait_days, 5);

    const del = await api(`/api/agent/sites/${site.id}/followup-rules/${followup_rule.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
  });

  // ── Setup condiviso per i test di follow-up reali ─────────────────────
  let ruleId, convOutId, convOutEmail;

  test("(d) checkFollowups: ultimo messaggio out 4gg fa → azione eseguita", async () => {
    const ruleRes = await api(`/api/agent/sites/${site.id}/followup-rules`, {
      method: "POST",
      body: {
        name: "Rispondi al lead",
        wait_days: 3,
        channel: "conversation",
        statuses: ["pending", "open"],
        action_type: "create_task",
        action_config: { title: "Follow-up: nessuna risposta" },
      },
    });
    const { followup_rule } = await ruleRes.json();
    ruleId = followup_rule.id;
    convOutEmail = `silenzio-${Date.now()}@example.test`;

    // Conversazione con ultimo messaggio OUT 4 giorni fa, stato pending.
    const conv = (await query(
      `INSERT INTO conversations (site_id, contact_email, channel, status, updated_at)
       VALUES ($1, $2, 'email', 'pending', NOW() - interval '4 days') RETURNING id`,
      [site.id, convOutEmail]
    )).rows[0];
    convOutId = conv.id;
    await query(
      `INSERT INTO conversation_messages (conversation_id, direction, body, created_at)
       VALUES ($1, 'out', 'Ultima proposta inviata', NOW() - interval '4 days')`,
      [convOutId]
    );

    const { checked, executed } = await checkFollowups();
    assert.ok(checked >= 1, `almeno una regola controllata (${checked})`);
    assert.ok(executed >= 1, `almeno un'azione eseguita (${executed})`);

    const taskRows = (await query(
      "SELECT * FROM tasks WHERE site_id = $1 AND email = $2",
      [site.id, convOutEmail]
    )).rows;
    assert.equal(taskRows.length, 1, "task creata per il contatto silenzioso");
    assert.equal(taskRows[0].title, "Follow-up: nessuna risposta");
    assert.match(taskRows[0].notes, new RegExp(convOutEmail));

    const runs = (await query(
      "SELECT * FROM followup_runs WHERE rule_id = $1 AND conversation_id = $2",
      [ruleId, convOutId]
    )).rows;
    assert.equal(runs.length, 1, "riga in followup_runs");
    assert.equal(runs[0].status, "ok");
    assert.equal(runs[0].action, "create_task");
  });

  test("(e) idempotenza: secondo check → nessuna nuova azione", async () => {
    const tasksBefore = (await query(
      "SELECT COUNT(*)::int AS c FROM tasks WHERE site_id = $1 AND email = $2",
      [site.id, convOutEmail]
    )).rows[0].c;

    const { executed } = await checkFollowups();
    assert.equal(executed, 0, "nessuna azione ripetuta senza nuovo messaggio in");

    const tasksAfter = (await query(
      "SELECT COUNT(*)::int AS c FROM tasks WHERE site_id = $1 AND email = $2",
      [site.id, convOutEmail]
    )).rows[0].c;
    assert.equal(tasksAfter, tasksBefore, "nessuna task duplicata");

    const runs = (await query(
      "SELECT COUNT(*)::int AS c FROM followup_runs WHERE rule_id = $1 AND conversation_id = $2",
      [ruleId, convOutId]
    )).rows[0].c;
    assert.equal(runs, 1, "ancora una sola riga in followup_runs");
  });

  test("(f) conversazione con ultimo messaggio IN recente → nessuna azione", async () => {
    const email = `recente-${Date.now()}@example.test`;
    const conv = (await query(
      `INSERT INTO conversations (site_id, contact_email, channel, status, updated_at)
       VALUES ($1, $2, 'email', 'pending', NOW()) RETURNING id`,
      [site.id, email]
    )).rows[0];
    await query(
      `INSERT INTO conversation_messages (conversation_id, direction, body, created_at)
       VALUES ($1, 'in', 'Risposta appena arrivata', NOW())`,
      [conv.id]
    );

    await checkFollowups();

    const runs = (await query(
      "SELECT COUNT(*)::int AS c FROM followup_runs WHERE rule_id = $1 AND conversation_id = $2",
      [ruleId, conv.id]
    )).rows[0].c;
    assert.equal(runs, 0, "nessuna esecuzione per conversazione con risposta recente");

    const tasks = (await query(
      "SELECT COUNT(*)::int AS c FROM tasks WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0].c;
    assert.equal(tasks, 0, "nessuna task generata");
  });

  test("(g) log followup-runs via API con filtro rule_id", async () => {
    const res = await api(`/api/agent/sites/${site.id}/followup-runs?rule_id=${ruleId}`);
    assert.equal(res.status, 200);
    const { runs } = await res.json();
    assert.ok(runs.length >= 1, "almeno la run del test (d) nel log");
    assert.ok(runs.every(r => r.rule_id === ruleId));
    assert.ok(runs.some(r => r.conversation_id === convOutId && r.status === "ok"));
  });
});
