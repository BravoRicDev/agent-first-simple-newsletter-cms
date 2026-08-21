import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

describe("ONDA 3 — export CSV + filtri/paginazione Attività e Email-stats", () => {
  let server, baseUrl, siteA, apiKeyA, campaignId, seqId, emails;

  before(async () => {
    siteA = await createTestSite("DVH CSV A");
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key", crypto.createHash("sha256").update(raw).digest("hex"), raw.slice(0, 12)]
    );
    apiKeyA = raw;

    emails = [uniqueEmail("csv1"), uniqueEmail("csv2")];
    // Inserisce attività (contact_events) con event_type differenziati.
    for (let i = 0; i < 5; i++) {
      await query(
        `INSERT INTO contact_events (site_id, email, event_type, payload)
         VALUES ($1, $2, $3, $4)`,
        [siteA.id, emails[i % 2], i % 2 === 0 ? "form_submitted" : "tag_added",
         JSON.stringify({ seq: i, note: `riga ${i}` })]
      );
    }

    const sub = await query(
      `INSERT INTO newsletter_subscribers (site_id, email, token) VALUES ($1, $2, $3) RETURNING id`,
      [siteA.id, uniqueEmail("csvsub"), `tok_${crypto.randomBytes(6).toString("hex")}`]
    );
    const camp = await query(
      `INSERT INTO newsletter_campaigns (site_id, subject, status, sent_at)
       VALUES ($1, 'CSV Campagna', 'sent', NOW()) RETURNING id`,
      [siteA.id]
    );
    campaignId = camp.rows[0].id;
    await query(
      `INSERT INTO newsletter_sends (campaign_id, subscriber_id, sent_at, opened_at, open_count)
       VALUES ($1, $2, NOW(), NOW(), 1)`,
      [campaignId, sub.rows[0].id]
    );
    const seq = await query(
      `INSERT INTO newsletter_sequences (site_id, name, active) VALUES ($1, 'CSV Seq', true) RETURNING id`,
      [siteA.id]
    );
    seqId = seq.rows[0].id;

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
    await query(`DELETE FROM newsletter_sequence_steps WHERE sequence_id = $1`, [seqId]);
    await query(`DELETE FROM newsletter_sequences WHERE id = $1`, [seqId]);
    await query(`DELETE FROM newsletter_sends WHERE campaign_id = $1`, [campaignId]);
    await query(`DELETE FROM newsletter_campaigns WHERE id = $1`, [campaignId]);
    await query(`DELETE FROM newsletter_subscribers WHERE site_id = $1`, [siteA.id]);
    await query(`DELETE FROM contact_events WHERE site_id = $1`, [siteA.id]);
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
    const res = await fetch(`${baseUrl}/v1${path}`, { method: opts.method || "GET", headers });
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body, ct };
  }

  test("GET /v1/activities → 200, total=5 e nextCursor presente", async () => {
    const r = await api("/activities", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 5);
    assert.equal(r.body.activities.length, 5);
    // nextCursor è null perché non c'è una pagina successiva con limit>=5.
    assert.equal(r.body.nextCursor, null);
  });

  test("GET /v1/activities?limit=2 → cursor pagination", async () => {
    const r1 = await api("/activities?limit=2", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.activities.length, 2);
    assert.equal(typeof r1.body.nextCursor, "number", "nextCursor deve essere un id numerico");

    const r2 = await api(`/activities?limit=2&cursor=${r1.body.nextCursor}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.activities.length, 2);
    // Nessuna sovrapposizione tra pagina 1 e 2.
    const ids1 = r1.body.activities.map((a) => a.id);
    const ids2 = r2.body.activities.map((a) => a.id);
    assert.ok(ids1.every((id) => !ids2.includes(id)), "pagine senza duplicati");
  });

  test("GET /v1/activities?eventType=tag_added → solo 2 righe", async () => {
    const r = await api("/activities?eventType=tag_added", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2);
    assert.ok(r.body.activities.every((a) => a.event_type === "tag_added"));
  });

  test("GET /v1/activities?email=<email> → solo righe del contatto", async () => {
    const r = await api(`/activities?email=${encodeURIComponent(emails[0])}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 3);
    assert.ok(r.body.activities.every((a) => a.email === emails[0]));
  });

  test("GET /v1/activities?from=<domani> → 0 (nessuna attività futura)", async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const r = await api(`/activities?from=${encodeURIComponent(tomorrow)}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
  });

  test("GET /v1/activities?format=csv → text/csv con header e righe", async () => {
    const r = await api("/activities?format=csv", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(r.ct.includes("text/csv"), `content-type ${r.ct}`);
    const lines = r.body.trim().split("\n");
    assert.ok(lines[0].startsWith("id,email,event_type,payload,created_at"));
    assert.equal(lines.length, 6, "header + 5 righe");
  });

  test("GET /v1/activities?format=csv&eventType=form_submitted → 3 righe dati", async () => {
    const r = await api("/activities?format=csv&eventType=form_submitted", { siteId: siteA.id, token: apiKeyA });
    const lines = r.body.trim().split("\n");
    assert.equal(lines.length, 4, "header + 3 righe form_submitted");
  });

  test("GET /v1/email-stats/campaigns?format=csv → CSV con campagna", async () => {
    const r = await api("/email-stats/campaigns?format=csv", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(r.ct.includes("text/csv"));
    const lines = r.body.trim().split("\n");
    assert.ok(lines[0].startsWith("id,subject,status"));
    assert.ok(lines.some((l) => l.includes("CSV Campagna")), "campagna presente nel CSV");
  });

  test("GET /v1/email-stats/campaigns?format=csv → 401 senza auth", async () => {
    const r = await api("/email-stats/campaigns?format=csv", { siteId: siteA.id, token: "" });
    assert.equal(r.status, 401);
  });

  test("GET /v1/email-stats/sequences?format=csv → CSV con sequenza", async () => {
    const r = await api("/email-stats/sequences?format=csv", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(r.ct.includes("text/csv"));
    const lines = r.body.trim().split("\n");
    assert.ok(lines[0].startsWith("id,name,active,steps"));
    assert.ok(lines.some((l) => l.includes("CSV Seq")), "sequenza presente nel CSV");
  });

  test("toCsv escapa virgole e quote nei valori", async () => {
    // test unitario sull'helper via import
    const { toCsv } = await import("../src/routes/v1.js");
    const csv = toCsv([{ name: 'a,"b",c' }], [{ key: "name", label: "nome" }]);
    assert.equal(csv, 'nome\n"a,""b"",c"');
  });
});