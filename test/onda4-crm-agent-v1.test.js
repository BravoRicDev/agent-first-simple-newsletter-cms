import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 4 bis — Esposizione route CRM agent (segmenti, workflow, scoring) su /v1
describe("ONDA 4 bis — CRM agent API su /v1", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;

  before(async () => {
    siteA = await createTestSite("O4bis Tenant A");
    siteB = await createTestSite("O4bis Tenant B");

    const mkKey = async (siteId, name) => {
      const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const r = await query(
        "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
        [siteId, name, hash, raw.slice(0, 12)]
      );
      return { id: r.rows[0].id, raw };
    };
    apiKeyA = await mkKey(siteA.id, "key A");
    apiKeyB = await mkKey(siteB.id, "key B");

    // Crea un contatto di test su A per i test di segmenti
    await query(
      "INSERT INTO contacts (site_id, email) VALUES ($1, $2)",
      [siteA.id, `segment-contact-${crypto.randomBytes(4).toString("hex")}@example.test`]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: err.message });
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

  const auth = (tenant, key) => ({
    "Location-Id": String(tenant),
    Authorization: `Bearer ${key}`,
    Version: "2017-04-19",
  });
  const postJson = (url, body, headers = {}) => fetch(url, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const putJson = (url, body, headers = {}) => fetch(url, {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // ── Auth ────────────────────────────────────────────────────────────────
  test("401 senza credenziali", async () => {
    const res = await fetch(`${baseUrl}/v1/segments`);
    assert.equal(res.status, 401);
  });

  // ── Segmenti CRUD ───────────────────────────────────────────────────────
  test("POST /segments — crea segmento", async () => {
    const res = await postJson(`${baseUrl}/v1/segments`, {
      name: "Segmento Test",
      description: "Segmento di test",
      rules: [{ field: "status", op: "eq", value: "active" }],
      match_mode: "all",
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.segment);
    assert.equal(body.segment.name, "Segmento Test");
    assert.equal(body.segment.site_id, siteA.id);
  });

  test("GET /segments — lista segmenti", async () => {
    const res = await fetch(`${baseUrl}/v1/segments`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.segments));
    assert.ok(body.segments.length >= 1);
    assert.ok("members" in body.segments[0]);
  });

  test("GET /segments/:id — dettaglio", async () => {
    const list = await (await fetch(`${baseUrl}/v1/segments`, { headers: auth(siteA.id, apiKeyA.raw) })).json();
    const id = list.segments[0].id;
    const res = await fetch(`${baseUrl}/v1/segments/${id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.segment.id, id);
  });

  test("PUT /segments/:id — aggiorna", async () => {
    const list = await (await fetch(`${baseUrl}/v1/segments`, { headers: auth(siteA.id, apiKeyA.raw) })).json();
    const id = list.segments[0].id;
    const res = await putJson(`${baseUrl}/v1/segments/${id}`, { name: "Seg Aggiornato", enabled: false }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.segment.name, "Seg Aggiornato");
    assert.equal(body.segment.enabled, false);
  });

  test("DELETE /segments/:id — elimina", async () => {
    // Crea un segmento usa-e-getta
    const create = await postJson(`${baseUrl}/v1/segments`, { name: "Da Eliminare" }, auth(siteA.id, apiKeyA.raw));
    const { id } = (await create.json()).segment;
    const res = await fetch(`${baseUrl}/v1/segments/${id}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);
    assert.equal(body.id, id);
    // Verifica 404
    const get = await fetch(`${baseUrl}/v1/segments/${id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(get.status, 404);
  });

  test("POST /segments/preview — anteprima segmento", async () => {
    const res = await postJson(`${baseUrl}/v1/segments/preview`, {
      rules: [{ field: "email", op: "contains", value: "@example.test" }],
      match_mode: "all",
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok("total" in body);
    assert.ok(Array.isArray(body.sample));
  });

  test("GET /segments/:id/members — membri", async () => {
    // Crea segmento e ricalcola
    const segRes = await postJson(`${baseUrl}/v1/segments`, {
      name: "Membri Test",
      rules: [{ field: "email", op: "contains", value: "@example.test" }],
    }, auth(siteA.id, apiKeyA.raw));
    const segId = (await segRes.json()).segment.id;
    await fetch(`${baseUrl}/v1/segments/${segId}/recount`, { method: "POST", headers: auth(siteA.id, apiKeyA.raw) });
    const res = await fetch(`${baseUrl}/v1/segments/${segId}/members`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.members));
    assert.ok(body.total >= 0);
  });

  test("Segments tenant isolation — B non vede i segmenti di A", async () => {
    const res = await fetch(`${baseUrl}/v1/segments`, { headers: auth(siteB.id, apiKeyB.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.segments.length, 0);
  });

  // ── Workflows CRUD ────────────────────────────────────────────────────
  test("POST /workflows — crea workflow", async () => {
    const res = await postJson(`${baseUrl}/v1/workflows`, {
      name: "WF Test",
      trigger_type: "manual",
      trigger_config: {},
      actions: [{ action_order: 1, action_type: "add_tag", action_config: { tag: "test" } }],
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.workflow);
    assert.equal(body.workflow.name, "WF Test");
    assert.ok(Array.isArray(body.workflow.actions));
    assert.equal(body.workflow.actions.length, 1);
  });

  test("GET /workflows — lista", async () => {
    const res = await fetch(`${baseUrl}/v1/workflows`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.workflows));
    assert.ok(body.workflows.length >= 1);
  });

  test("GET /workflows/:id — dettaglio con actions", async () => {
    const list = await (await fetch(`${baseUrl}/v1/workflows`, { headers: auth(siteA.id, apiKeyA.raw) })).json();
    const id = list.workflows[0].id;
    const res = await fetch(`${baseUrl}/v1/workflows/${id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workflow.id, id);
    assert.ok(Array.isArray(body.workflow.actions));
  });

  test("PUT /workflows/:id — aggiorna", async () => {
    const list = await (await fetch(`${baseUrl}/v1/workflows`, { headers: auth(siteA.id, apiKeyA.raw) })).json();
    const id = list.workflows[0].id;
    const res = await putJson(`${baseUrl}/v1/workflows/${id}`, {
      name: "WF Aggiornato",
      active: false,
      trigger_config: { form_slug: "test" },
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workflow.name, "WF Aggiornato");
    assert.equal(body.workflow.active, false);
  });

  test("DELETE /workflows/:id — elimina", async () => {
    const create = await postJson(`${baseUrl}/v1/workflows`, {
      name: "WF Da Eliminare",
      trigger_type: "manual",
      actions: [{ action_order: 1, action_type: "add_tag", action_config: { tag: "x" } }],
    }, auth(siteA.id, apiKeyA.raw));
    const { id } = (await create.json()).workflow;
    const res = await fetch(`${baseUrl}/v1/workflows/${id}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);
    assert.equal(body.id, id);
  });

  test("POST /workflows/:id/test — test su email valida", async () => {
    const create = await postJson(`${baseUrl}/v1/workflows`, {
      name: "WF Test Run",
      trigger_type: "manual",
      actions: [{ action_order: 1, action_type: "add_tag", action_config: { tag: "test-run" } }],
    }, auth(siteA.id, apiKeyA.raw));
    const { id } = (await create.json()).workflow;
    const res = await postJson(`${baseUrl}/v1/workflows/${id}/test`, { email: "test-run@example.test" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    // testWorkflow può ritornare ok o errore a seconda della presenza contatto
  });

  test("POST /workflows/:id/test — 400 per email non valida", async () => {
    const list = await (await fetch(`${baseUrl}/v1/workflows`, { headers: auth(siteA.id, apiKeyA.raw) })).json();
    const id = list.workflows[0].id;
    const res = await postJson(`${baseUrl}/v1/workflows/${id}/test`, { email: "non-valida" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 400);
  });

  test("Workflows tenant isolation — B non vede i workflow di A", async () => {
    const res = await fetch(`${baseUrl}/v1/workflows`, { headers: auth(siteB.id, apiKeyB.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workflows.length, 0);
  });

  // ── Scoring Rules CRUD ─────────────────────────────────────────────────
  test("POST /scoring-rules — crea regola", async () => {
    const res = await postJson(`${baseUrl}/v1/scoring-rules`, {
      name: "Regola Test",
      event_type: "form_submitted",
      points: 10,
      event_filter: { form_slug: "contact" },
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.rule);
    assert.equal(body.rule.name, "Regola Test");
    assert.equal(body.rule.points, 10);
  });

  test("GET /scoring-rules — lista", async () => {
    const res = await fetch(`${baseUrl}/v1/scoring-rules`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.rules));
    assert.ok(body.rules.length >= 1);
  });

  test("GET /scoring-rules/:id — dettaglio", async () => {
    const list = await (await fetch(`${baseUrl}/v1/scoring-rules`, { headers: auth(siteA.id, apiKeyA.raw) })).json();
    const id = list.rules[0].id;
    const res = await fetch(`${baseUrl}/v1/scoring-rules/${id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rule.id, id);
  });

  test("PUT /scoring-rules/:id — aggiorna", async () => {
    const list = await (await fetch(`${baseUrl}/v1/scoring-rules`, { headers: auth(siteA.id, apiKeyA.raw) })).json();
    const id = list.rules[0].id;
    const res = await putJson(`${baseUrl}/v1/scoring-rules/${id}`, { points: 25, enabled: false }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rule.points, 25);
    assert.equal(body.rule.enabled, false);
  });

  test("DELETE /scoring-rules/:id — elimina", async () => {
    const create = await postJson(`${baseUrl}/v1/scoring-rules`, {
      name: "Regola Da Eliminare",
      event_type: "manual",
      points: 5,
    }, auth(siteA.id, apiKeyA.raw));
    const { id } = (await create.json()).rule;
    const res = await fetch(`${baseUrl}/v1/scoring-rules/${id}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);
    assert.equal(body.id, id);
  });

  // ── Scoring Thresholds CRUD ────────────────────────────────────────────
  test("POST /scoring-thresholds — crea soglia", async () => {
    const res = await postJson(`${baseUrl}/v1/scoring-thresholds`, {
      min_score: 50,
      action_type: "add_tag",
      action_config: { tag: "hot" },
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.threshold);
    assert.equal(body.threshold.min_score, 50);
  });

  test("GET /scoring-thresholds — lista", async () => {
    const res = await fetch(`${baseUrl}/v1/scoring-thresholds`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.thresholds));
    assert.ok(body.thresholds.length >= 1);
  });

  test("DELETE /scoring-thresholds/:id — elimina", async () => {
    const create = await postJson(`${baseUrl}/v1/scoring-thresholds`, {
      min_score: 99,
      action_type: "set_stage",
      action_config: { stage: "qualified" },
    }, auth(siteA.id, apiKeyA.raw));
    const { id } = (await create.json()).threshold;
    const res = await fetch(`${baseUrl}/v1/scoring-thresholds/${id}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);
    assert.equal(body.id, id);
  });

  test("Scoring tenant isolation — B non vede regole di A", async () => {
    const res = await fetch(`${baseUrl}/v1/scoring-rules`, { headers: auth(siteB.id, apiKeyB.raw) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rules.length, 0);
  });

  // ── Errori / edge cases ─────────────────────────────────────────────────
  test("POST /segments — 400 senza name", async () => {
    const res = await postJson(`${baseUrl}/v1/segments`, {}, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 400);
  });

  test("PUT /segments/:id — 404 id inesistente", async () => {
    const res = await putJson(`${baseUrl}/v1/segments/999999`, { name: "Nope" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 404);
  });

  test("POST /scoring-rules — 400 senza event_type", async () => {
    const res = await postJson(`${baseUrl}/v1/scoring-rules`, { name: "Senza tipo" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 400);
  });

  test("POST /scoring-thresholds — 400 senza min_score", async () => {
    const res = await postJson(`${baseUrl}/v1/scoring-thresholds`, { action_type: "add_tag", action_config: {} }, auth(siteA.id, apiKeyA.raw));
    assert.equal(res.status, 400);
  });

  test("DELETE /segments/:id — 404 id inesistente", async () => {
    const res = await fetch(`${baseUrl}/v1/segments/999999`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 404);
  });

  test("GET /segments/:id/members — 404 segmento inesistente", async () => {
    const res = await fetch(`${baseUrl}/v1/segments/999999/members`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(res.status, 404);
  });
});