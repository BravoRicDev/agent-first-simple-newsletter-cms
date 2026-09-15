import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// Segmenti dinamici (F1): CRUD + valutazione regole + membership + preview.
describe("crm: segmenti dinamici", () => {
  let site, user, server, baseUrl, token, segmentId;

  before(async () => {
    site = await createTestSite("CRM Segments Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm segments", 30);
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

  test("POST /segments crea segmento con regola tag", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Lead caldi",
        rules: [{ field: "tag", op: "has", value: "qualifica-lead" }],
        match_mode: "all",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.segment.id);
    assert.equal(body.segment.name, "Lead caldi");
    segmentId = body.segment.id;
  });

  test("GET /segments elenca con conteggio membri 0", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.segments.length, 1);
    assert.equal(parseInt(body.segments[0].members, 10), 0);
  });

  test("un contatto con il tag diventa membro dopo refreshSegmentsForContact", async () => {
    const { addContactTag } = await import("../src/services/contacts.js");
    const { refreshSegmentsForContact } = await import("../src/services/segments.js");
    await addContactTag(site.id, "mario@example.test", "qualifica-lead");
    const result = await refreshSegmentsForContact(site.id, "mario@example.test");
    assert.equal(result.added.length, 1, "il contatto deve entrare nel segmento");

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments`, { headers: auth() });
    const body = await res.json();
    assert.equal(parseInt(body.segments[0].members, 10), 1);
  });

  test("GET /segments/:id/members mostra l'email", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments/${segmentId}/members`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.members[0].email, "mario@example.test");
  });

  test("segments/preview (dry-run) matchano gli stessi contatti", async () => {
    const rules = JSON.stringify([{ field: "tag", op: "has", value: "qualifica-lead" }]);
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments/preview?rules=${encodeURIComponent(rules)}`, { headers: auth() });
    const body = await res.json();
    assert.ok(body.total >= 1);
    assert.ok(body.sample.includes("mario@example.test"));
  });

  test("regola evento gte_days_ago su quiz_completed", async () => {
    const { emitContactEvent } = await import("../src/services/events.js");
    await emitContactEvent(site.id, "luigi@example.test", "quiz_completed", { quiz_slug: "qualifica-lead", points: 10 });

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments/preview?rules=${encodeURIComponent(JSON.stringify([{ field: "event", op: "gte_days_ago", value: "quiz_completed", days: 30 }]))}`, { headers: auth() });
    const body = await res.json();
    assert.ok(body.total >= 1, "luigi deve matchare l'evento recente");
    assert.ok(body.sample.includes("luigi@example.test"));
  });

  test("DELETE /segments/:id elimina", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments/${segmentId}`, { method: "DELETE", headers: auth() });
    assert.equal(res.status, 200);
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/segments`, { headers: auth() });
    assert.equal((await list.json()).segments.length, 0);
  });
});
