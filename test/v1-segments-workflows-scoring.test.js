import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 4 — Segmenti, Workflow, Scoring su /v1 (CRM agent features).
describe("v1 — Segmenti, Workflow, Scoring", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;
  let contactEmail;

  before(async () => {
    siteA = await createTestSite("SW Tenant A");
    siteB = await createTestSite("SW Tenant B");

    const mk = async (siteId, name) => {
      const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const r = await query(
        "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
        [siteId, name, hash, raw.slice(0, 12)]
      );
      return { id: r.rows[0].id, raw };
    };
    apiKeyA = await mk(siteA.id, "key A");
    apiKeyB = await mk(siteB.id, "key B");

    // Crea un contatto per test
    contactEmail = uniqueEmail("sw-contact");
    await query(
      "INSERT INTO contacts (site_id, email, tags, status, score) VALUES ($1, $2, $3, 'active', 10)",
      [siteA.id, contactEmail, ["lead", "web"]]
    );

    // Crea un evento contatto per test segmenti
    await query(
      "INSERT INTO contact_events (site_id, email, event_type) VALUES ($1, $2, 'form_submitted')",
      [siteA.id, contactEmail]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    await new Promise((resolve) => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // Segmenti
  // ─────────────────────────────────────────────────────────────────────────

  describe("Segmenti — /v1/segments", () => {
    let segId;

    test("401 senza credenziali", async () => {
      const res = await fetch(`${baseUrl}/v1/segments`);
      assert.equal(res.status, 401);
    });

    test("Crea segmento", async () => {
      const res = await postJson(`${baseUrl}/v1/segments`, {
        name: "Lead attivi",
        description: "Contatti con tag lead",
        rules: [{ field: "tag", op: "has", value: "lead" }],
        match_mode: "all",
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(body.segment?.id);
      assert.equal(body.segment.name, "Lead attivi");
      assert.equal(body.segment.match_mode, "all");
      segId = body.segment.id;
    });

    test("Lista segmenti", async () => {
      const res = await fetch(`${baseUrl}/v1/segments`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.segments));
      assert.ok(body.segments.some((s) => s.id === segId));
      // Verifica conteggio members (LEFT JOIN)
      assert.ok(body.segments[0].members !== undefined);
    });

    test("Dettaglio segmento", async () => {
      const res = await fetch(`${baseUrl}/v1/segments/${segId}`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.segment.id, segId);
      assert.equal(body.segment.name, "Lead attivi");
    });

    test("Segmento 404 per altro tenant", async () => {
      const res = await fetch(`${baseUrl}/v1/segments/${segId}`, {
        headers: auth(siteB.id, apiKeyB.raw),
      });
      assert.equal(res.status, 404);
    });

    test("404 per id inesistente", async () => {
      const res = await fetch(`${baseUrl}/v1/segments/999999`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 404);
    });

    test("Aggiorna segmento", async () => {
      const res = await putJson(`${baseUrl}/v1/segments/${segId}`, {
        name: "Lead attivi aggiornato",
        enabled: false,
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.segment.name, "Lead attivi aggiornato");
      assert.equal(body.segment.enabled, false);
    });

    test("Errore 400 se nome vuoto in creazione", async () => {
      const res = await postJson(`${baseUrl}/v1/segments`, {
        name: "",
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 400);
    });

    test("Preview segmento", async () => {
      const res = await postJson(`${baseUrl}/v1/segments/preview`, {
        rules: [{ field: "tag", op: "has", value: "lead" }],
        match_mode: "all",
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.total === "number");
      assert.ok(Array.isArray(body.sample));
    });

    test("Membri segmento", async () => {
      const res = await fetch(`${baseUrl}/v1/segments/${segId}/members?limit=10`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.members));
      assert.ok(body.total !== undefined);
    });

    test("Recount segmento", async () => {
      const res = await fetch(`${baseUrl}/v1/segments/${segId}/recount`, {
        method: "POST",
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.total !== undefined);
    });

    test("Elimina segmento", async () => {
      const res = await fetch(`${baseUrl}/v1/segments/${segId}`, {
        method: "DELETE",
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.deleted, true);
      // Verifica non più leggibile
      const getRes = await fetch(`${baseUrl}/v1/segments/${segId}`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(getRes.status, 404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Workflow
  // ─────────────────────────────────────────────────────────────────────────

  describe("Workflow — /v1/workflows", () => {
    let wfId;

    test("Crea workflow con azioni", async () => {
      const res = await postJson(`${baseUrl}/v1/workflows`, {
        name: "Notifica form",
        trigger_type: "form_submitted",
        trigger_config: { form_slug: "contatti" },
        actions: [
          { action_type: "add_tag", action_config: { tag: "form-lead" } },
          { action_type: "create_task", action_config: { title: "Follow-up form", due_in_days: 1 } },
        ],
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(body.workflow?.id);
      assert.equal(body.workflow.name, "Notifica form");
      assert.equal(body.workflow.trigger_type, "form_submitted");
      assert.ok(Array.isArray(body.workflow.actions));
      assert.equal(body.workflow.actions.length, 2);
      wfId = body.workflow.id;
    });

    test("Lista workflow", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.workflows));
      assert.ok(body.workflows.some((w) => w.id === wfId));
      // Verifica action_count
      assert.ok(body.workflows[0].action_count !== undefined);
    });

    test("Dettaglio workflow con azioni", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${wfId}`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.workflow.id, wfId);
      assert.ok(Array.isArray(body.workflow.actions));
      assert.equal(body.workflow.actions.length, 2);
    });

    test("404 per altro tenant", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${wfId}`, {
        headers: auth(siteB.id, apiKeyB.raw),
      });
      assert.equal(res.status, 404);
    });

    test("Aggiorna workflow", async () => {
      const res = await putJson(`${baseUrl}/v1/workflows/${wfId}`, {
        name: "Notifica aggiornata",
        active: false,
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.workflow.name, "Notifica aggiornata");
      assert.equal(body.workflow.active, false);
    });

    test("Aggiorna workflow con azioni sostituite", async () => {
      const res = await putJson(`${baseUrl}/v1/workflows/${wfId}`, {
        actions: [
          { action_type: "notify_email", action_config: { to: "admin@test.local", subject: "Nuovo lead" } },
        ],
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.workflow.actions.length, 1);
      assert.equal(body.workflow.actions[0].action_type, "notify_email");
    });

    test("Errore 400 se trigger_type non valido", async () => {
      const res = await postJson(`${baseUrl}/v1/workflows`, {
        name: "Invalido",
        trigger_type: "invalid_trigger_type_xyz",
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 400);
    });

    test("Test workflow su contatto esistente", async () => {
      const res = await postJson(`${baseUrl}/v1/workflows/${wfId}/test`, {
        email: contactEmail,
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.workflow);
      assert.ok(Array.isArray(body.would_run));
    });

    test("Workflow runs — storico vuoto all'inizio", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${wfId}/runs`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.runs));
    });

    test("Elimina workflow", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${wfId}`, {
        method: "DELETE",
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.deleted, true);
      const getRes = await fetch(`${baseUrl}/v1/workflows/${wfId}`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(getRes.status, 404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scoring Rules
  // ─────────────────────────────────────────────────────────────────────────

  describe("Scoring Rules — /v1/scoring-rules", () => {
    let ruleId;

    test("401 senza credenziali", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-rules`);
      assert.equal(res.status, 401);
    });

    test("Crea regola di scoring", async () => {
      const res = await postJson(`${baseUrl}/v1/scoring-rules`, {
        name: "Form compilato",
        event_type: "form_submitted",
        event_filter: { form_slug: "contatti" },
        points: 15,
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(body.rule?.id);
      assert.equal(body.rule.name, "Form compilato");
      assert.equal(body.rule.points, 15);
      assert.equal(body.rule.enabled, true);
      ruleId = body.rule.id;
    });

    test("Lista regole", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-rules`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.rules));
      assert.ok(body.rules.some((r) => r.id === ruleId));
    });

    test("Dettaglio regola", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-rules/${ruleId}`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.rule.id, ruleId);
      assert.equal(body.rule.name, "Form compilato");
    });

    test("404 per altro tenant", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-rules/${ruleId}`, {
        headers: auth(siteB.id, apiKeyB.raw),
      });
      assert.equal(res.status, 404);
    });

    test("Aggiorna regola", async () => {
      const res = await putJson(`${baseUrl}/v1/scoring-rules/${ruleId}`, {
        name: "Form compilato (alto)",
        points: 30,
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.rule.name, "Form compilato (alto)");
      assert.equal(body.rule.points, 30);
    });

    test("Errore 400 se event_type non valido", async () => {
      const res = await postJson(`${baseUrl}/v1/scoring-rules`, {
        name: "Regola invalida",
        event_type: "invalid_type",
        points: 5,
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 400);
    });

    test("Elimina regola", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-rules/${ruleId}`, {
        method: "DELETE",
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.deleted, true);
      const getRes = await fetch(`${baseUrl}/v1/scoring-rules/${ruleId}`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(getRes.status, 404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scoring Thresholds
  // ─────────────────────────────────────────────────────────────────────────

  describe("Scoring Thresholds — /v1/scoring-thresholds", () => {
    let thId;

    test("401 senza credenziali", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-thresholds`);
      assert.equal(res.status, 401);
    });

    test("Crea soglia di scoring", async () => {
      const res = await postJson(`${baseUrl}/v1/scoring-thresholds`, {
        min_score: 50,
        action_type: "add_tag",
        action_config: { tag: "hot-lead" },
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(body.threshold?.id);
      assert.equal(body.threshold.min_score, 50);
      assert.equal(body.threshold.action_type, "add_tag");
      thId = body.threshold.id;
    });

    test("Crea seconda soglia", async () => {
      const res = await postJson(`${baseUrl}/v1/scoring-thresholds`, {
        min_score: 100,
        action_type: "set_stage",
        action_config: { stage: "qualificato" },
      }, auth(siteA.id, apiKeyA.raw));
      assert.equal(res.status, 201);
    });

    test("Lista soglie", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-thresholds`, {
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.thresholds));
      assert.ok(body.thresholds.length >= 2);
      // Ordinate per min_score crescente
      assert.ok(body.thresholds[0].min_score <= body.thresholds[1].min_score);
    });

    test("404 per altro tenant", async () => {
      // Non possiamo leggere la soglia di A da B via DELETE without GET,
      // ma possiamo provare a cancellare una soglia di A da B
      const res = await fetch(`${baseUrl}/v1/scoring-thresholds/${thId}`, {
        method: "DELETE",
        headers: auth(siteB.id, apiKeyB.raw),
      });
      assert.equal(res.status, 404);
    });

    test("Elimina soglia", async () => {
      const res = await fetch(`${baseUrl}/v1/scoring-thresholds/${thId}`, {
        method: "DELETE",
        headers: auth(siteA.id, apiKeyA.raw),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.deleted, true);
    });
  });
});