import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerHitlRoutes } from "../src/routes/agent-hitl.js";
import jwt from "jsonwebtoken";
import config from "../src/config.js";

// Feature 32 — Human-in-the-loop: coda di approvazione.
// L'agente AI enqueue un'azione sensibile (task, messaggio out, modifica
// contatto…); l'operatore approva/rifiuta; solo all'approvazione il
// payload viene eseguito. Niente import di agentRouter: il modulo route
// viene montato su un router locale con requireAuth + requireAgent, come
// prescritto per i moduli registrati dal router padre.
// Fix CORREZIONI-TRACCIATE: approve/reject richiedono un UMANO admin
// (token API vietato, auto-approvazione vietata, decided_by dal token).
describe("crm: human-in-the-loop (coda di approvazione)", () => {
  let site, user, server, baseUrl, token, humanToken, collaboratorToken;

  before(async () => {
    site = await createTestSite("CRM HITL Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm hitl", 30);
    token = created.token;

    // JWT "umano" admin: non è un token API (niente api_token), quindi può
    // decidere; email fissa per verificare che decided_by venga dal token.
    const uv = (await query("SELECT token_version FROM users WHERE id = $1", [user.id])).rows[0];
    const sign = (role, email) => jwt.sign(
      { sub: user.id, email, name: user.name, role, site_id: site.id, token_version: uv.token_version, agent: true },
      config.jwtSecret,
      { expiresIn: "1h", algorithm: "HS256" }
    );
    humanToken = sign("admin", "admin@example.test");
    collaboratorToken = sign("collaboratore", "collab@example.test");

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerHitlRoutes(r);

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
  const humanAuth = () => ({ Authorization: `Bearer ${humanToken}` });
  const collaboratorAuth = () => ({ Authorization: `Bearer ${collaboratorToken}` });
  const approvalsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/approvals${extra}`;

  test("enqueue + list con filtro status e kind", async () => {
    const res1 = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      // requested_by nel body viene IGNORATO: conta il token (qui API token).
      body: JSON.stringify({ kind: "task", payload: { action_type: "create_task", task: { title: "Chiama Mario", email: "hitl.task@example.test" } }, requested_by: "agent-hermes" }),
    });
    assert.equal(res1.status, 200);
    const { approval } = await res1.json();
    assert.ok(approval.id);
    assert.equal(approval.kind, "task");
    assert.equal(approval.status, "pending");
    assert.equal(approval.requested_by, `api:${user.id}`, "requested_by dal token API, mai dal body");
    assert.equal(approval.payload.action_type, "create_task");

    const res2 = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "custom", payload: { note: "approvazione libera" } }),
    });
    assert.equal(res2.status, 200);

    // Filtro kind=task → solo la prima.
    const listTask = await fetch(approvalsUrl("?kind=task"), { headers: auth() });
    const { approvals: taskApprovals } = await listTask.json();
    assert.equal(taskApprovals.length, 1);
    assert.equal(taskApprovals[0].kind, "task");

    // Filtro status=pending → entrambe (nessuna ancora decisa).
    const listPending = await fetch(approvalsUrl("?status=pending"), { headers: auth() });
    assert.equal((await listPending.json()).approvals.length, 2);

    // Filtro status=approved → nessuna.
    const listApproved = await fetch(approvalsUrl("?status=approved"), { headers: auth() });
    assert.equal((await listApproved.json()).approvals.length, 0);
  });

  test("kind non valido → 400", async () => {
    const res = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "delete_site", payload: {} }),
    });
    assert.equal(res.status, 400);
  });

  test("approve con token API → 403 (solo operatori umani)", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "task", payload: { action_type: "create_task", task: { title: "Nessuno", email: "api@example.test" } } }),
    });
    const { approval } = await enq.json();

    // Stesso token API usato per enqueue tenta di approvare → 403.
    const appr = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
    });
    assert.equal(appr.status, 403);
    const body = await appr.json();
    assert.match(body.error, /umani/i, "errore che spiega il requisito umano");
    assert.equal(approval.status, "pending", "resta pending");
  });

  test("approve con utente collaboratore → 403", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "custom", payload: { note: "x" } }),
    });
    const { approval } = await enq.json();

    const appr = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...collaboratorAuth(), "Content-Type": "application/json" },
    });
    assert.equal(appr.status, 403);
    assert.match((await appr.json()).error, /admin/i);
    assert.equal(approval.status, "pending");
  });

  test("auto-approvazione bloccata: stesso umano che enqueue e approva → 403", async () => {
    // L'umano enqueue con il suo JWT → requested_by = user:admin@example.test.
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "custom", payload: { note: "auto" } }),
    });
    const { approval } = await enq.json();
    assert.equal(approval.requested_by, "user:admin@example.test");

    // Lo STESSO umano prova ad approvare la propria richiesta → 403.
    const appr = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
    });
    assert.equal(appr.status, 403);
    const body = await appr.json();
    assert.match(body.error, /auto-approvazione/i);
    assert.equal(approval.status, "pending", "resta pending");
  });

  test("approve kind=task → esegue createTask (azione all'approvazione)", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "task", payload: { action_type: "create_task", task: { title: "Chiama", email: "x@example.test" } }, requested_by: "agent" }),
    });
    const { approval } = await enq.json();

    const appr = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
      // decided_by nel body viene IGNORATO: conta l'identità dal token.
      body: JSON.stringify({ decided_by: "staff@example.test" }),
    });
    assert.equal(appr.status, 200);
    const body = await appr.json();
    assert.equal(body.approval.status, "approved");
    assert.equal(body.approval.decided_by, "user:admin@example.test", "decided_by dal token, mai dal body");
    assert.ok(body.approval.decided_at);
    assert.equal(body.action_error, null, "nessun errore di azione");

    // La task è stata creata davvero nella tabella tasks.
    const rows = (await query(
      "SELECT * FROM tasks WHERE site_id = $1 AND email = $2 AND title = $3",
      [site.id, "x@example.test", "Chiama"]
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "open");
  });

  test("approve kind=outbound_message → messaggio out nel thread + conversazione open", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "outbound_message",
        payload: { message: { channel: "email", email: "x@example.test", body: "Ciao", subject: "Soggetto" } },
        requested_by: "agent",
      }),
    });
    const { approval } = await enq.json();

    const appr = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
    });
    assert.equal(appr.status, 200);
    const body = await appr.json();
    assert.equal(body.approval.status, "approved");
    assert.equal(body.action_error, null);

    const msgs = (await query(
      `SELECT m.direction, m.body, c.status AS conv_status
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.site_id = $1 AND c.contact_email = $2 AND c.channel = 'email'`,
      [site.id, "x@example.test"]
    )).rows;
    const out = msgs.find(m => m.direction === "out");
    assert.ok(out, "messaggio out registrato nel thread");
    assert.equal(out.body, "Ciao");
    assert.equal(out.conv_status, "open", "la conversazione viene riaperta all'approvazione");
  });

  test("approve su approvazione già decisa → 409 (no double-execute)", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "task", payload: { action_type: "create_task", task: { title: "Una volta sola", email: "once@example.test" } } }),
    });
    const { approval } = await enq.json();

    const first = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
    });
    assert.equal(first.status, 200);

    // Secondo approve: la UPDATE condizionale su status='pending' non
    // tocca nulla → 409, e l'azione NON viene rieseguita.
    const second = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
    });
    assert.equal(second.status, 409);

    const tasks = (await query(
      "SELECT COUNT(*)::int AS c FROM tasks WHERE site_id = $1 AND title = $2",
      [site.id, "Una volta sola"]
    )).rows[0];
    assert.equal(tasks.c, 1, "azione eseguita una sola volta");
  });

  test("reject → status rejected, nessuna azione eseguita", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "task", payload: { action_type: "create_task", task: { title: "Non farlo", email: "reject@example.test" } } }),
    });
    const { approval } = await enq.json();

    const rej = await fetch(approvalsUrl(`/${approval.id}/reject`), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ decided_by: "staff@example.test" }),
    });
    assert.equal(rej.status, 200);
    const body = await rej.json();
    assert.equal(body.approval.status, "rejected");
    assert.equal(body.approval.decided_by, "user:admin@example.test", "decided_by dal token, mai dal body");
    assert.ok(body.approval.decided_at);

    const tasks = (await query(
      "SELECT COUNT(*)::int AS c FROM tasks WHERE site_id = $1 AND title = $2",
      [site.id, "Non farlo"]
    )).rows[0];
    assert.equal(tasks.c, 0, "nessuna task creata al reject");
  });

  test("delete → rimuove la riga (anche pending)", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "custom", payload: { note: "da eliminare" } }),
    });
    const { approval } = await enq.json();

    const del = await fetch(approvalsUrl(`/${approval.id}`), {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, approval.id);

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM approval_queue WHERE id = $1 AND site_id = $2",
      [approval.id, site.id]
    )).rows[0];
    assert.equal(rows.c, 0);
  });

  test("audit log: approval_approve registrato con entity_type=approval", async () => {
    const enq = await fetch(approvalsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "task", payload: { action_type: "create_task", task: { title: "Audit", email: "audit@example.test" } } }),
    });
    const { approval } = await enq.json();
    const appr = await fetch(approvalsUrl(`/${approval.id}/approve`), {
      method: "POST",
      headers: { ...humanAuth(), "Content-Type": "application/json" },
    });
    assert.equal(appr.status, 200);

    const logs = (await query(
      `SELECT action, entity_type, entity_id, new_data FROM audit_log
       WHERE site_id = $1 AND action = 'approval_approve' AND entity_type = 'approval'
       ORDER BY id DESC LIMIT 3`,
      [site.id]
    )).rows;
    assert.ok(logs.length >= 1, "audit_log contiene approval_approve");
    const log = logs.find(l => l.entity_id === approval.id);
    assert.ok(log, "entry collegata all'id dell'approvazione");
    assert.equal(log.new_data.kind, "task");
    assert.equal(log.new_data.action_error, null);
  });
});
