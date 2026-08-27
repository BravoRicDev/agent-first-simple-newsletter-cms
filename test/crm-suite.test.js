import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import { transparentGif, sanitizeClickUrl, injectClickTracking } from "../src/services/tracking-email.js";

// Scoring (F4) + task/funnel (F5) + email tracking (F3) + preferenze (F7)
// + merge (F8) + pipeline multiple (F9).
describe("crm: scoring, task, tracking, preferenze, merge, pipeline", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Suite Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm suite", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    // Error handler di debug: trasforma errori non gestiti in JSON per i test
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

  // ── F4 Scoring ─────────────────────────────────────────────────────────
  test("scoring: crea regola + soglia, evento → punteggio e stadio", async () => {
    const ruleRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/scoring-rules`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Quiz +10", event_type: "quiz_completed", event_filter: { quiz_slug: "qualifica-lead" }, points: 10 }),
    });
    assert.equal(ruleRes.status, 200);

    const thRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/scoring-thresholds`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ min_score: 10, action_type: "set_stage", action_config: { stage: "contattato" } }),
    });
    assert.equal(thRes.status, 200);

    const { emitContactEvent } = await import("../src/services/events.js");
    await emitContactEvent(site.id, "score@example.test", "quiz_completed", { quiz_slug: "qualifica-lead", points: 10 });

    const contact = (await query("SELECT score, status FROM contacts WHERE site_id = $1 AND email = 'score@example.test'", [site.id])).rows[0];
    assert.ok(contact, "contatto creato");
    assert.equal(contact.score, 10, "punteggio accumulato");
    assert.equal(contact.status, "contattato", "soglia raggiunta → cambio stadio");
  });

  test("scoring: regola disattivata non dà punti", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/scoring-rules`, { headers: auth() });
    const rules = (await res.json()).rules;
    await query("UPDATE scoring_rules SET enabled = false WHERE id = $1", [rules[0].id]);

    const { emitContactEvent } = await import("../src/services/events.js");
    await emitContactEvent(site.id, "score@example.test", "quiz_completed", { quiz_slug: "qualifica-lead", points: 5 });
    const contact = (await query("SELECT score FROM contacts WHERE site_id = $1 AND email = 'score@example.test'", [site.id])).rows[0];
    assert.equal(contact.score, 10, "nessun nuovo punto da regola disattivata");
  });

  test("scoring: decadimento giornaliero (score * 0.95)", async () => {
    const { applyScoringDecay } = await import("../src/services/scoring.js");
    await query("UPDATE contacts SET score_updated_at = NOW() - INTERVAL '2 days' WHERE site_id = $1 AND email = 'score@example.test'", [site.id]);
    const result = await applyScoringDecay(site.id);
    assert.equal(result.decayed, 1);
    const contact = (await query("SELECT score FROM contacts WHERE site_id = $1 AND email = 'score@example.test'", [site.id])).rows[0];
    assert.equal(contact.score, Math.round(10 * 0.95 * 0.95), "2 giorni di decadimento");
  });

  // ── F5 Task ────────────────────────────────────────────────────────────
  test("task: CRUD completo", async () => {
    const createRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/tasks`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Chiama Mario", email: "mario@example.test", due_at: new Date(Date.now() + 86400000).toISOString() }),
    });
    assert.equal(createRes.status, 200);
    const task = (await createRes.json()).task;
    assert.ok(task.id);

    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/tasks?status=open`, { headers: auth() });
    const list = (await listRes.json()).tasks;
    assert.ok(list.length >= 1);

    const updateRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/tasks/${task.id}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const updated = (await updateRes.json()).task;
    assert.equal(updated.status, "done");
    assert.ok(updated.done_at, "done_at deve essere valorizzato");

    const delRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/tasks/${task.id}`, { method: "DELETE", headers: auth() });
    assert.equal(delRes.status, 200);
  });

  // ── F3 Email tracking ──────────────────────────────────────────────────
  test("tracking-email: sanitizeClickUrl blocca javascript:/userinfo", () => {
    assert.equal(sanitizeClickUrl("https://example.com"), "https://example.com/");
    assert.equal(sanitizeClickUrl("javascript:alert(1)"), "/");
    assert.equal(sanitizeClickUrl("https://evil.com@trusted.com"), "/");
    assert.equal(sanitizeClickUrl("data:text/html,<script>"), "/");
    assert.equal(sanitizeClickUrl(""), "/");
  });

  test("tracking-email: injectClickTracking riscrive link http/https, non mailto", () => {
    const html = '<a href="https://example.com/page">x</a> <a href="mailto:a@b.it">m</a> <a href="#anchor">a</a>';
    const out = injectClickTracking(html, { kind: "c", sendId: 5, baseUrl: "https://www.example.it" });
    assert.ok(out.includes("/track/click/c/5?u="), "il link http deve essere riscritto");
    assert.ok(!out.includes('href="https://example.com/page"'), "l'URL originale deve sparire");
    assert.ok(out.includes('mailto:a@b.it'), "mailto invariato");
    assert.ok(out.includes('#anchor'), "ancora invariata");
  });

  test("tracking: pixel GIF 1x1 valido", () => {
    const gif = transparentGif();
    assert.ok(gif.length > 0);
    assert.equal(gif[0], 0x47); // 'G'
    assert.equal(gif[1], 0x49); // 'I'
    assert.equal(gif[2], 0x46); // 'F'
  });

  // ── F7 Preferenze ──────────────────────────────────────────────────────
  test("preferenze: genera token e aggiorna", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/prefs@example.test/pref-token`, {
      method: "POST",
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const { token: prefToken } = await res.json();
    assert.ok(prefToken, "token generato");

    const { setPreferences, getContactByPrefToken } = await import("../src/services/preferences.js");
    await setPreferences(site.id, "prefs@example.test", { pref_sms: true, pref_marketing: false });
    const contact = await getContactByPrefToken(prefToken);
    assert.equal(contact.pref_sms, true);
    assert.equal(contact.pref_marketing, false);
  });

  // ── F8 Merge ───────────────────────────────────────────────────────────
  test("merge: unisce contatti e riaggancia", async () => {
    const { addContactTag } = await import("../src/services/contacts.js");
    await addContactTag(site.id, "dup1@example.test", "tag-uno");
    await addContactTag(site.id, "dup2@example.test", "tag-due");
    await query("UPDATE contacts SET score = 20 WHERE site_id = $1 AND email = 'dup2@example.test'", [site.id]);

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/contacts/dup1@example.test/merge`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ into_email: "dup2@example.test" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    const merged = (await query("SELECT tags, score FROM contacts WHERE site_id = $1 AND email = 'dup2@example.test'", [site.id])).rows[0];
    assert.ok(merged.tags.includes("tag-uno") && merged.tags.includes("tag-due"), "tag uniti");
    assert.equal(merged.score, 20, "score max");

    const gone = (await query("SELECT 1 FROM contacts WHERE site_id = $1 AND email = 'dup1@example.test'", [site.id])).rows;
    assert.equal(gone.length, 0, "sorgente eliminato");
  });

  // ── F9 Pipeline multiple ───────────────────────────────────────────────
  test("pipeline: crea pipeline custom con stadi", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pipelines`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Consulenze",
        stages: [{ key: "nuovo", label: "Nuovo" }, { key: "qualificato", label: "Qualificato" }, { key: "vinto", label: "Vinto" }],
        is_default: true,
      }),
    });
    assert.equal(res.status, 200);
    const pipeline = (await res.json()).pipeline;
    assert.equal(pipeline.stages.length, 3);

    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pipelines`, { headers: auth() });
    const pipelines = (await list.json()).pipelines;
    assert.equal(pipelines.length, 1);
    assert.equal(pipelines[0].name, "Consulenze");
  });
});
