import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerSandboxRoutes } from "../src/routes/agent-sandbox.js";

// Feature 42 — Sandbox/staging: dry-run di segmenti/workflow/agenti/
// preventivi con log delle esecuzioni (sandbox_runs) e scenari
// riutilizzabili (sandbox_scenarios). Il modulo route è montato su un
// router LOCALE (niente agentRouter): l'auth requireAuth/requireAgent è
// applicata dal mount.
describe("crm: sandbox/staging (dry-run + scenari)", () => {
  let site, otherSite, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Sandbox Test");
    otherSite = await createTestSite("CRM Sandbox Altro Sito");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "sandbox", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerSandboxRoutes(r);

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
  const runPath = (id = site.id) => `${baseUrl}/api/agent/sites/${id}/sandbox/run`;
  const scenariosPath = (id = site.id) => `${baseUrl}/api/agent/sites/${id}/sandbox/scenarios`;
  const runsPath = (id = site.id) => `${baseUrl}/api/agent/sites/${id}/sandbox/runs`;

  test("(a) run kind 'quote' calcola il totale e registra la riga in sandbox_runs", async () => {
    const res = await fetch(runPath(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "quote",
        input: {
          title: "Preventivo prova",
          items: [
            { description: "Sito web", qty: 1, price: 1500 },
            { description: "Manutenzione", qty: 12, price: 49.5 },
          ],
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sandbox_run_id, "deve ritornare sandbox_run_id");
    assert.equal(body.output.valid, true);
    assert.equal(body.output.total, 1500 + 12 * 49.5);

    const row = (await query(
      "SELECT kind, input, output FROM sandbox_runs WHERE id = $1",
      [body.sandbox_run_id]
    )).rows[0];
    assert.ok(row, "la riga deve essere registrata in sandbox_runs");
    assert.equal(row.kind, "quote");
    assert.ok(row.input.items.length === 2);
  });

  test("(b) run kind 'segment' fa l'anteprima senza creare contatti (side-effect zero)", async () => {
    await query(
      `INSERT INTO contacts (site_id, email, status)
       VALUES ($1, $2, 'lead') ON CONFLICT (site_id, email) DO NOTHING`,
      [site.id, "mario-sandbox@example.test"]
    );
    const beforeCount = parseInt(
      (await query("SELECT COUNT(*) AS c FROM contacts WHERE site_id = $1", [site.id])).rows[0].c, 10
    );

    const res = await fetch(runPath(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "segment",
        input: { match_mode: "all", rules: [{ field: "status", op: "eq", value: "lead" }] },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sandbox_run_id);
    assert.ok(Array.isArray(body.output.sample), "sample deve essere un array di email");
    assert.ok(body.output.sample.includes("mario-sandbox@example.test"), "deve matchare il contatto lead");

    const afterCount = parseInt(
      (await query("SELECT COUNT(*) AS c FROM contacts WHERE site_id = $1", [site.id])).rows[0].c, 10
    );
    assert.equal(afterCount, beforeCount, "il dry-run non deve creare contatti");
  });

  test("(c) run kind 'workflow' su workflow inesistente → output.error gestito (200, non 500)", async () => {
    const res = await fetch(runPath(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "workflow", input: { workflow_id: 99999999, email: "x@example.test" } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.output.error, "output.error deve essere presente");
    assert.ok(body.sandbox_run_id, "anche l'errore viene registrato nello storico");
  });

  test("(d) kind non valido → 400", async () => {
    const res = await fetch(runPath(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "pipeline", input: {} }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "Kind non supportato");
  });

  test("(e) CRUD scenari riutilizzabili", async () => {
    const created = await fetch(scenariosPath(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test segmento lead",
        kind: "segment",
        input: { rules: [{ field: "status", op: "eq", value: "lead" }], match_mode: "all" },
      }),
    });
    assert.equal(created.status, 200);
    const scenario = (await created.json()).scenario;
    assert.ok(scenario.id);
    assert.equal(scenario.kind, "segment");

    const list = await fetch(scenariosPath(), { headers: auth() });
    assert.equal((await list.json()).scenarios.length, 1);

    const updated = await fetch(`${scenariosPath()}/${scenario.id}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test rinominato" }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).scenario.name, "Test rinominato");

    const deleted = await fetch(`${scenariosPath()}/${scenario.id}`, { method: "DELETE", headers: auth() });
    assert.equal(deleted.status, 200);
    const list2 = await fetch(scenariosPath(), { headers: auth() });
    assert.equal((await list2.json()).scenarios.length, 0);
  });

  test("(f) listSandboxRuns con filtro kind", async () => {
    const res = await fetch(`${runsPath()}?kind=quote`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.runs.length >= 1, "deve esserci almeno il run quote del caso (a)");
    for (const run of body.runs) {
      assert.equal(run.kind, "quote");
    }
  });

  test("(g) 403 su sito di un altro account", async () => {
    const res = await fetch(scenariosPath(otherSite.id), { headers: auth() });
    assert.equal(res.status, 403);
    const res2 = await fetch(runPath(otherSite.id), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "quote", input: { items: [{ description: "x", qty: 1, price: 1 }] } }),
    });
    assert.equal(res2.status, 403);
  });
});
