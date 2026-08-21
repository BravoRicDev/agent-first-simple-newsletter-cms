import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

describe("ONDA 3 planning — v1 sequences stats / PUT tags / DELETE task / import HTTP", () => {
  let server, baseUrl, siteA, apiKeyA, sequenceId, contactId, taskId, subId;

  before(async () => {
    siteA = await createTestSite("DVH PlanningOnda3 A");
    const crypto = (await import("crypto")).default;
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key", crypto.createHash("sha256").update(raw).digest("hex"), raw.slice(0, 12)]
    );
    apiKeyA = raw;

    // sequenza + step + send per testare le stats
    const seq = await query(
      `INSERT INTO newsletter_sequences (site_id, name, active) VALUES ($1, 'Seq Test', true) RETURNING id`,
      [siteA.id]
    );
    sequenceId = seq.rows[0].id;
    const step = await query(
      `INSERT INTO newsletter_sequence_steps (sequence_id, step_order, delay_days, subject)
       VALUES ($1, 1, 0, 'Step 1') RETURNING id`,
      [sequenceId]
    );
    const sub = await query(
      `INSERT INTO newsletter_subscribers (site_id, email, token) VALUES ($1, $2, $3) RETURNING id`,
      [siteA.id, uniqueEmail("seqsub"), `tok_${Math.random().toString(36).slice(2)}`]
    );
    subId = sub.rows[0].id;
    await query(
      `INSERT INTO newsletter_sequence_sends (step_id, subscriber_id, sent_at, opened_at, open_count)
       VALUES ($1, $2, NOW(), NOW(), 1)`,
      [step.rows[0].id, subId]
    );

    // contatto con tags per testare PUT replace + task per DELETE
    const contact = await query(
      `INSERT INTO contacts (site_id, email, tags)
       VALUES ($1, $2, '{"a","b","c"}') RETURNING id, email`,
      [siteA.id, uniqueEmail("plan")]
    );
    contactId = contact.rows[0].id;
    const t = await query(
      `INSERT INTO tasks (site_id, title, email, status) VALUES ($1, 'da cancellare', $2, 'open') RETURNING id`,
      [siteA.id, contact.rows[0].email]
    );
    taskId = t.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/v1", v1Routes);
    app.use((req, res) => res.status(404).json({ error: "not found" }));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    await query(`DELETE FROM tasks WHERE email IN (SELECT email FROM contacts WHERE id = $1)`, [contactId]);
    await query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
    await query(`DELETE FROM newsletter_sequence_sends WHERE step_id IN (SELECT id FROM newsletter_sequence_steps WHERE sequence_id = $1)`, [sequenceId]);
    await query(`DELETE FROM newsletter_sequence_steps WHERE sequence_id = $1`, [sequenceId]);
    await query(`DELETE FROM newsletter_sequences WHERE id = $1`, [sequenceId]);
    await query(`DELETE FROM import_jobs WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM newsletter_subscribers WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM site_api_keys WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM sites WHERE id = $1`, [siteA.id]);
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.siteId !== undefined) headers["Location-Id"] = String(opts.siteId);
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method: opts.method || "GET", headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  test("GET /v1/email-stats/sequences → lista sequenze con stats", async () => {
    const r = await api("/email-stats/sequences", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.sequences));
    const s = r.body.sequences.find((x) => x.id === sequenceId);
    assert.ok(s, "sequenza presente");
    assert.equal(s.sent, 1);
    assert.equal(s.opened, 1);
    assert.equal(s.steps, 1);
  });

  test("GET /v1/email-stats/sequences/:id → dettaglio sequenza", async () => {
    const r = await api(`/email-stats/sequences/${sequenceId}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.emailStats.sequence.id, sequenceId);
    assert.equal(r.body.emailStats.steps.length, 1);
  });

  test("GET /v1/email-stats/sequences/999999 → 404", async () => {
    const r = await api("/email-stats/sequences/999999", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 404);
  });

  test("PUT /v1/contacts/:id/tags → sostituisce completamente i tags", async () => {
    const r = await api(`/contacts/${contactId}/tags`, {
      siteId: siteA.id, token: apiKeyA, method: "PUT", body: { tags: ["x", "y"] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tags, ["x", "y"]);
  });

  test("PUT /v1/contacts/:id/tags → empty array azzera i tags", async () => {
    const r = await api(`/contacts/${contactId}/tags`, {
      siteId: siteA.id, token: apiKeyA, method: "PUT", body: { tags: [] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tags, []);
  });

  test("DELETE /v1/contacts/:id/tasks/:taskId → elimina task", async () => {
    const r = await api(`/contacts/${contactId}/tasks/${taskId}`, {
      siteId: siteA.id, token: apiKeyA, method: "DELETE",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    const check = await query(`SELECT 1 FROM tasks WHERE id = $1`, [taskId]);
    assert.equal(check.rows.length, 0);
  });

  test("DELETE task inesistente → 404", async () => {
    const r = await api(`/contacts/${contactId}/tasks/999999`, {
      siteId: siteA.id, token: apiKeyA, method: "DELETE",
    });
    assert.equal(r.status, 404);
  });

  test("POST /v1/import → bulk upsert contatti (job_id + conteggi)", async () => {
    const r = await api("/import", {
      siteId: siteA.id, token: apiKeyA, method: "POST",
      body: { contacts: [{ email: uniqueEmail("imp1"), first_name: "Imp" }] },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.job_id, "job_id presente");
    assert.ok(r.body.imported >= 1);
  });

  test("GET /v1/import/jobs → lista job del tenant", async () => {
    const r = await api("/import/jobs", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.jobs));
    assert.ok(r.body.jobs.length >= 1);
  });
});