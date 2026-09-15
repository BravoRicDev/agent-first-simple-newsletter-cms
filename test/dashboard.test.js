import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerDashboardRoutes } from "../src/routes/agent-dashboard.js";

// Feature 40 — Dashboard realtime CRM: KPI live (lead per canale, SLA task,
// valore pipeline, conversazioni, attività) + viste salvabili. Come
// prescritto NON si importa agentRouter: il modulo agent è montato su un
// router locale con requireAuth + requireAgent.
describe("feature 40: dashboard realtime CRM", () => {
  let site, user, token, server, baseUrl;
  let viewId;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const kpisUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/dashboard/kpis${extra}`;
  const viewsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/dashboard/views${extra}`;

  before(async () => {
    site = await createTestSite("CRM Dashboard Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "dashboard test", 30);
    token = created.token;

    // Dati di test via query dirette: 2 lead recenti (facebook, google),
    // 1 lead vecchio 40 giorni (organic), 1 opportunity open (1000×50%),
    // 1 task open senza due_at, 1 task open in ritardo, 1 conversazione
    // open, 1 evento contact_events.
    await query(
      `INSERT INTO contacts (site_id, email, utm_source, status, created_at)
       VALUES ($1, $2, 'facebook', 'lead', NOW())`,
      [site.id, uniqueEmail("fb")]
    );
    await query(
      `INSERT INTO contacts (site_id, email, utm_source, status, created_at)
       VALUES ($1, $2, 'google', 'lead', NOW())`,
      [site.id, uniqueEmail("gg")]
    );
    await query(
      `INSERT INTO contacts (site_id, email, utm_source, status, created_at)
       VALUES ($1, $2, 'organic', 'lead', NOW() - INTERVAL '40 days')`,
      [site.id, uniqueEmail("org")]
    );
    await query(
      `INSERT INTO opportunities (site_id, contact_email, title, amount, probability, status)
       VALUES ($1, $2, 'Deal test', 1000, 50, 'open')`,
      [site.id, uniqueEmail("deal")]
    );
    await query(
      `INSERT INTO tasks (site_id, email, title, status, due_at)
       VALUES ($1, $2, 'Task senza scadenza', 'open', NULL)`,
      [site.id, uniqueEmail("t1")]
    );
    await query(
      `INSERT INTO tasks (site_id, email, title, status, due_at)
       VALUES ($1, $2, 'Task in ritardo', 'open', NOW() - INTERVAL '1 day')`,
      [site.id, uniqueEmail("t2")]
    );
    await query(
      `INSERT INTO conversations (site_id, contact_email, channel, status)
       VALUES ($1, $2, 'email', 'open')`,
      [site.id, uniqueEmail("conv")]
    );
    await query(
      `INSERT INTO contact_events (site_id, email, event_type, payload)
       VALUES ($1, $2, 'contact_created', '{"source":"test"}')`,
      [site.id, uniqueEmail("evt")]
    );

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerDashboardRoutes(r);
    app.use(r);
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  test("GET kpis (default 30d): lead, canali, pipeline, task, conversazioni, attività", async () => {
    const res = await fetch(kpisUrl(), { headers: auth() });
    assert.equal(res.status, 200);
    const k = await res.json();

    assert.equal(k.range, "30d");
    assert.ok(k.generated_at);
    assert.equal(k.leads, 2, "i lead recenti nel range 30d devono essere 2 (organic è fuori range)");
    const channels = k.leads_by_channel.map(c => c.channel).sort();
    assert.deepEqual(channels, ["facebook", "google"]);
    assert.equal(k.pipeline_value, 500, "1000 × 50% = 500");
    assert.equal(k.open_opportunities, 1);
    assert.equal(typeof k.win_rate, "number");
    assert.ok(k.tasks_open >= 2);
    assert.ok(k.tasks_overdue >= 1, "almeno la task con due_at nel passato è in ritardo");
    assert.ok(k.conversations_open >= 1);
    assert.ok(k.recent_activity.length >= 1, "l'evento contact_events deve comparire");
    assert.equal(typeof k.email_stats, "object");
    assert.ok(k.new_leads_7d >= 2);
  });

  test("range 7d esclude il contatto creato 40 giorni fa", async () => {
    const res = await fetch(kpisUrl("?range=7d"), { headers: auth() });
    assert.equal(res.status, 200);
    const k = await res.json();
    assert.equal(k.range, "7d");
    assert.equal(k.leads, 2);
    assert.ok(!k.leads_by_channel.some(c => c.channel === "organic"), "organic (40gg) non deve comparire nel range 7d");
  });

  test("range 90d include il contatto vecchio (organic)", async () => {
    const res = await fetch(kpisUrl("?range=90d"), { headers: auth() });
    assert.equal(res.status, 200);
    const k = await res.json();
    assert.equal(k.range, "90d");
    assert.equal(k.leads, 3);
    assert.ok(k.leads_by_channel.some(c => c.channel === "organic" && c.count === 1));
  });

  test("range non valido → default 30d", async () => {
    const res = await fetch(kpisUrl("?range=bogus"), { headers: auth() });
    assert.equal(res.status, 200);
    const k = await res.json();
    assert.equal(k.range, "30d");
    assert.equal(k.leads, 2);
  });

  test("CRUD viste salvabili", async () => {
    // POST: crea vista con config widget
    const post = await fetch(viewsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Vista test", config: { widgets: [{ type: "kpi", key: "leads" }] } }),
    });
    assert.equal(post.status, 200);
    const created = (await post.json()).view;
    assert.ok(created.id);
    assert.equal(created.name, "Vista test");
    assert.deepEqual(created.config.widgets, [{ type: "kpi", key: "leads" }]);
    viewId = created.id;

    // Sanitizzazione: config con 25 widget → max 20
    const many = await fetch(viewsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Vista troppi widget",
        config: { widgets: Array.from({ length: 25 }, (_, i) => ({ i })) },
      }),
    });
    assert.equal(many.status, 200);
    assert.equal((await many.json()).view.config.widgets.length, 20);

    // GET: la lista contiene la vista
    const list = await fetch(viewsUrl(), { headers: auth() });
    assert.equal(list.status, 200);
    const { views } = await list.json();
    assert.ok(views.some(v => v.id === viewId));

    // PUT: rinomina + config vuoto
    const put = await fetch(viewsUrl(`/${viewId}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Vista rinominata", config: { widgets: [] } }),
    });
    assert.equal(put.status, 200);
    const updated = (await put.json()).view;
    assert.equal(updated.name, "Vista rinominata");
    assert.deepEqual(updated.config.widgets, []);

    // DELETE: sparita dalla lista
    const del = await fetch(viewsUrl(`/${viewId}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, viewId);
    const after = await fetch(viewsUrl(), { headers: auth() });
    assert.ok(!(await after.json()).views.some(v => v.id === viewId), "la vista eliminata non deve comparire");
  });

  test("404 su vista inesistente, 403 su sito non accessibile, 400 su nome mancante", async () => {
    const missing = await fetch(viewsUrl("/999999"), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(missing.status, 404);

    const forbidden = await fetch(`${baseUrl}/api/agent/sites/999999/dashboard/kpis`, { headers: auth() });
    assert.equal(forbidden.status, 403);

    const noName = await fetch(viewsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(noName.status, 400);
  });
});
