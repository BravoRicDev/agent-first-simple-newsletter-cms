import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

describe("ONDA 3 — v1 email-stats HTTP routes", () => {
  let server, baseUrl, siteA, apiKeyA, campaignId;

  before(async () => {
    siteA = await createTestSite("DVH EmailStats A");
    const crypto = (await import("crypto")).default;
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true)",
      [siteA.id, "key", crypto.createHash("sha256").update(raw).digest("hex"), raw.slice(0, 12)]
    );
    apiKeyA = raw;

    const sub = await query(
      `INSERT INTO newsletter_subscribers (site_id, email, token) VALUES ($1, $2, $3) RETURNING id`,
      [siteA.id, uniqueEmail("hsub"), `tok_${Math.random().toString(36).slice(2)}`]
    );
    const camp = await query(
      `INSERT INTO newsletter_campaigns (site_id, subject, status, sent_at)
       VALUES ($1, 'HTTP Campagna', 'sent', NOW()) RETURNING id`,
      [siteA.id]
    );
    campaignId = camp.rows[0].id;
    await query(
      `INSERT INTO newsletter_sends (campaign_id, subscriber_id, sent_at, opened_at, open_count)
       VALUES ($1, $2, NOW(), NOW(), 1)`,
      [campaignId, sub.rows[0].id]
    );

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
    await query(`DELETE FROM newsletter_sends WHERE campaign_id = $1`, [campaignId]);
    await query(`DELETE FROM newsletter_campaigns WHERE id = $1`, [campaignId]);
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
    const res = await fetch(`${baseUrl}/v1${path}`, { method: opts.method || "GET", headers });
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body };
  }

  test("GET /v1/email-stats → 200 con aggregato", async () => {
    const r = await api("/email-stats", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.emailStats.total, 1);
    assert.equal(r.body.emailStats.opened, 1);
    assert.equal(r.body.emailStats.open_rate, 1);
  });

  test("GET /v1/email-stats → 401 senza auth", async () => {
    const r = await api("/email-stats", { siteId: siteA.id, token: "" });
    assert.equal(r.status, 401);
  });

  test("GET /v1/email-stats/campaigns → lista con stats", async () => {
    const r = await api("/email-stats/campaigns", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.campaigns));
    const c = r.body.campaigns.find((x) => x.id === campaignId);
    assert.ok(c, "campagna presente");
    assert.equal(c.total, 1);
    assert.equal(c.opened, 1);
  });

  test("GET /v1/email-stats/campaigns/:id → dettaglio campagna", async () => {
    const r = await api(`/email-stats/campaigns/${campaignId}`, { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 200);
    assert.equal(r.body.emailStats.campaign.id, campaignId);
    assert.equal(r.body.emailStats.total, 1);
  });

  test("GET /v1/email-stats/campaigns/999999 → 404", async () => {
    const r = await api("/email-stats/campaigns/999999", { siteId: siteA.id, token: apiKeyA });
    assert.equal(r.status, 404);
  });
});