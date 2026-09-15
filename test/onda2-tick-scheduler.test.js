import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import { resetTickCounter } from "../src/services/tick.js";

// ONDA2 Phase 6: POST /api/agent/tick esegue le azioni differite dei
// workflow (workflow_delayed_actions) scadute, oltre a decay/refresh
// segmenti (coperti dagli altri due file onda2-*).
describe("crm: tick scheduler — azioni differite", () => {
  let site, user, token, server, baseUrl;

  before(async () => {
    site = await createTestSite("CRM Tick Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "tick", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  beforeEach(() => resetTickCounter());

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const api = (path, opts = {}) => fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { ...auth(), ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  async function makeWorkflow(email) {
    const w = (await query(
      "INSERT INTO workflows (site_id, name, active, trigger_type, trigger_config) VALUES ($1, 'wf tick', true, 'manual', '{}') RETURNING id",
      [site.id]
    )).rows[0];
    await query(
      `INSERT INTO workflow_delayed_actions (site_id, workflow_id, email, action_type, action_config, run_at, status)
       VALUES ($1, $2, $3, 'add_tag', $4, NOW() - INTERVAL '1 minute', 'pending')`,
      [site.id, w.id, email, JSON.stringify({ tag: "tick-eseguito" })]
    );
    return w.id;
  }

  test("(a) senza site_id, utente non superadmin → 403", async () => {
    const res = await api("/api/agent/tick", { method: "POST" });
    assert.equal(res.status, 403);
  });

  test("(b) con site_id: esegue l'azione differita scaduta ed è idempotente", async () => {
    const email = uniqueEmail("tick");
    await makeWorkflow(email);

    const res = await api("/api/agent/tick", { method: "POST", body: { site_id: site.id, run_decay: false, run_segments: false } });
    assert.equal(res.status, 200);
    const { tick } = await res.json();
    assert.ok(tick.delayed_actions.executed >= 1, `almeno un'azione eseguita (${tick.delayed_actions.executed})`);
    assert.equal(tick.scoring_decay, null, "run_decay=false → step saltato");
    assert.equal(tick.segment_refresh, null, "run_segments=false → step saltato");

    const contact = (await query(
      "SELECT tags FROM contacts WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.ok(contact.tags.includes("tick-eseguito"), "tag applicato dall'azione differita");

    const row = (await query(
      "SELECT status FROM workflow_delayed_actions WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(row.status, "done");

    // Un secondo tick non ritrova nulla da eseguire per questa email (status != pending).
    const res2 = await api("/api/agent/tick", { method: "POST", body: { site_id: site.id, run_decay: false, run_segments: false } });
    const { tick: tick2 } = await res2.json();
    const stillPending = (await query(
      "SELECT COUNT(*)::int AS c FROM workflow_delayed_actions WHERE site_id = $1 AND email = $2 AND status = 'pending'",
      [site.id, email]
    )).rows[0].c;
    assert.equal(stillPending, 0);
  });

  test("(c) accesso a un sito non proprio → 403", async () => {
    const otherSite = await createTestSite("Altro sito");
    const res = await api("/api/agent/tick", { method: "POST", body: { site_id: otherSite.id } });
    assert.equal(res.status, 403);
  });

  test("(d) site_id non valido → 400", async () => {
    const res = await api("/api/agent/tick", { method: "POST", body: { site_id: "abc" } });
    assert.equal(res.status, 400);
  });

  test("(e) risposta include un contatore tick incrementale", async () => {
    const r1 = await api("/api/agent/tick", { method: "POST", body: { site_id: site.id, run_decay: false, run_segments: false } });
    const { tick: t1 } = await r1.json();
    const r2 = await api("/api/agent/tick", { method: "POST", body: { site_id: site.id, run_decay: false, run_segments: false } });
    const { tick: t2 } = await r2.json();
    assert.equal(t2.tick, t1.tick + 1);
  });
});
