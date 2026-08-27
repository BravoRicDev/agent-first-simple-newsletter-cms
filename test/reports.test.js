import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerReportsRoutes } from "../src/routes/agent-reports.js";
import config from "../src/config.js";
import { resetTransporter } from "../src/services/email.js";

// Feature 41 — Report periodici ai clienti.
// Niente import di agentRouter: il modulo route viene montato su un router
// locale con requireAuth + requireAgent, come prescritto per i moduli
// registrati dal router padre.
//
// SMTP nei test: il .env di sistema ha SMTP_HOST valorizzato (smtps.aruba.it)
// → mandare una email vera dai test è inaccettabile. Prima di ogni invio
// puntiamo config.smtpHost su 127.0.0.1 (nessun listener sulla porta 465 nel
// container): sendEmail fallisce SUBITO con ECONNREFUSED, nessuna email
// reale parte, nessun hang. sendReport deve catturare l'errore, rispondere
// 200 con { sent: 0, errors: [...] } e registrare un run con status 'error'.
describe("crm: report periodici ai clienti", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    config.smtpHost = "127.0.0.1";
    config.smtpPort = 465;
    resetTransporter();

    site = await createTestSite("CRM Report Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm reports", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerReportsRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
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
  const configsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/report-configs${extra}`;

  function postConfig(body) {
    return fetch(configsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("CRUD config: create → list → update → delete → 404 (sanitizzazione kind/sections/recipients)", async () => {
    // Create: kind invalido, sezioni con fuori-whitelist + duplicati,
    // recipients con email invalida + duplicata → tutto sanitizzato.
    const created = await postConfig({
      name: "Report settimanale",
      kind: "monthly",
      sections: ["leads", "pipeline", "bogus", "leads", "tasks"],
      recipients: ["a@example.test", "not-an-email", "b@example.test", "a@example.test"],
    });
    assert.equal(created.status, 200);
    const { config } = await created.json();
    assert.ok(config.id, "config creata con id");
    assert.equal(config.site_id, site.id);
    assert.equal(config.name, "Report settimanale");
    assert.equal(config.kind, "monthly");
    assert.deepEqual(config.sections, ["leads", "pipeline", "tasks"], "bogus scartata e duplicati rimossi");
    assert.deepEqual(config.recipients, ["a@example.test", "b@example.test"], "email invalida scartata e duplicati rimossi");
    assert.equal(config.active, true);
    assert.equal(config.last_sent_at, null);

    // List: la config è presente.
    const listRes = await fetch(configsUrl(), { headers: auth() });
    assert.equal(listRes.status, 200);
    const { configs } = await listRes.json();
    assert.ok(Array.isArray(configs));
    assert.ok(configs.some(c => c.id === config.id), "config presente nella lista");

    // Update: nome, kind, sezioni, recipients, active.
    const put = await fetch(configsUrl(`/${config.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Report rinominato",
        kind: "weekly",
        sections: ["conversations", "email"],
        recipients: ["c@example.test"],
        active: false,
      }),
    });
    assert.equal(put.status, 200);
    const { config: updated } = await put.json();
    assert.equal(updated.id, config.id, "stessa riga");
    assert.equal(updated.name, "Report rinominato");
    assert.equal(updated.kind, "weekly");
    assert.deepEqual(updated.sections, ["conversations", "email"]);
    assert.deepEqual(updated.recipients, ["c@example.test"]);
    assert.equal(updated.active, false);

    // Delete → 200 con id; seconda delete → 404.
    const del = await fetch(configsUrl(`/${config.id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, config.id);

    const again = await fetch(configsUrl(`/${config.id}`), { method: "DELETE", headers: auth() });
    assert.equal(again.status, 404);

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM report_configs WHERE id = $1 AND site_id = $2",
      [config.id, site.id]
    )).rows[0];
    assert.equal(rows.c, 0, "riga eliminata dal DB");
  });

  test("kind non valido → 400 (create e update)", async () => {
    const bad = await postConfig({ name: "X", kind: "daily" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "Tipo report non valido: usare 'weekly' o 'monthly'");

    const created = await postConfig({ name: "Valida", kind: "weekly" });
    const { config } = await created.json();
    const badPut = await fetch(configsUrl(`/${config.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "yearly" }),
    });
    assert.equal(badPut.status, 400);

    // Nome mancante → 400.
    const noName = await postConfig({ kind: "weekly" });
    assert.equal(noName.status, 400);
  });

  test("generate: html con nome config e sezioni, json con leads/pipeline/tasks, NON invia nulla", async () => {
    const created = await postConfig({ name: "Report Demo", kind: "weekly" });
    const { config } = await created.json();

    const res = await fetch(configsUrl(`/${config.id}/generate`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.config_id, config.id);
    assert.ok(body.generated_at, "generated_at presente");
    assert.equal(typeof body.html, "string");
    assert.ok(body.html.includes("Report Demo"), "html contiene il nome della config");
    assert.ok(body.html.includes("Lead"), "html contiene le sezioni");
    assert.ok(body.html.includes("Task"), "html contiene le sezioni");

    assert.ok(body.json.leads, "json contiene la sezione leads");
    assert.ok(Number.isInteger(body.json.leads.total), "leads.total è un intero");
    assert.ok(Number.isInteger(body.json.leads.new_leads_7d), "leads.new_leads_7d è un intero");
    assert.ok(body.json.pipeline, "json contiene la sezione pipeline");
    assert.equal(typeof body.json.pipeline.pipeline_value, "number");
    assert.ok(Number.isInteger(body.json.pipeline.open_opportunities));
    assert.ok(body.json.tasks, "json contiene la sezione tasks");
    assert.ok(Number.isInteger(body.json.tasks.tasks_open));
    assert.ok(Number.isInteger(body.json.tasks.tasks_done_7d));

    // Dry-run: nessun run registrato e last_sent_at invariato (NULL).
    const runs = (await query(
      "SELECT COUNT(*)::int AS c FROM report_runs WHERE site_id = $1 AND config_id = $2",
      [site.id, config.id]
    )).rows[0];
    assert.equal(runs.c, 0, "generate NON registra run");
    const cfg = (await query("SELECT last_sent_at FROM report_configs WHERE id = $1", [config.id])).rows[0];
    assert.equal(cfg.last_sent_at, null, "generate NON tocca last_sent_at");
  });

  test("generate su config inesistente → 404", async () => {
    const res = await fetch(configsUrl("/999999/generate"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "Configurazione non trovata");
  });

  test("send senza recipients → {error:'Nessun destinatario'} e NESSUN run registrato", async () => {
    const created = await postConfig({ name: "Senza destinatari", kind: "weekly" });
    const { config } = await created.json();

    const res = await fetch(configsUrl(`/${config.id}/send`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).error, "Nessun destinatario");

    const runs = (await query(
      "SELECT COUNT(*)::int AS c FROM report_runs WHERE site_id = $1 AND config_id = $2",
      [site.id, config.id]
    )).rows[0];
    assert.equal(runs.c, 0, "nessun run registrato senza destinatari");
  });

  test("send con recipient ma SMTP irraggiungibile → {sent:0, errors:[...]}, run status error, risposta 200", async () => {
    const created = await postConfig({
      name: "Invio fallito",
      kind: "weekly",
      recipients: ["client@example.test"],
    });
    const { config } = await created.json();

    const res = await fetch(configsUrl(`/${config.id}/send`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200, "nessun crash: risposta 200");
    const body = await res.json();
    assert.equal(body.sent, 0);
    assert.ok(Array.isArray(body.errors));
    assert.ok(body.errors.length > 0, "almeno un errore di invio");
    assert.ok(body.errors[0].includes("client@example.test"), "l'errore cita il destinatario");

    // Run registrato con status 'error' e il messaggio di errore.
    const run = (await query(
      "SELECT status, error FROM report_runs WHERE site_id = $1 AND config_id = $2 ORDER BY id DESC LIMIT 1",
      [site.id, config.id]
    )).rows[0];
    assert.ok(run, "run registrato");
    assert.equal(run.status, "error");
    assert.ok(run.error.length > 0);

    // last_sent_at NON aggiornato → la config resta scaduta per lo scheduler.
    const cfg = (await query("SELECT last_sent_at FROM report_configs WHERE id = $1", [config.id])).rows[0];
    assert.equal(cfg.last_sent_at, null);
  });

  test("listRuns: i run degli invii falliti sono visibili via API; config inesistente → 404", async () => {
    const created = await postConfig({
      name: "Con log",
      kind: "weekly",
      recipients: ["client2@example.test"],
    });
    const { config } = await created.json();

    for (let i = 0; i < 2; i++) {
      const res = await fetch(configsUrl(`/${config.id}/send`), {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.sent, 0);
      assert.ok(body.errors.length > 0);
    }

    const runsRes = await fetch(configsUrl(`/${config.id}/runs?limit=10`), { headers: auth() });
    assert.equal(runsRes.status, 200);
    const { runs } = await runsRes.json();
    assert.ok(Array.isArray(runs));
    assert.equal(runs.length, 2, "due run registrati");
    assert.ok(runs.every(r => r.status === "error"), "tutti i run hanno status error");
    assert.ok(runs[0].created_at >= runs[1].created_at, "ordinati per created_at DESC");

    // Config inesistente → 404 anche per i run.
    const missing = await fetch(configsUrl("/999999/runs"), { headers: auth() });
    assert.equal(missing.status, 404);
  });

  test("accesso ad altro sito → 403", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/999999/report-configs`, { headers: auth() });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Accesso negato");
  });
});
