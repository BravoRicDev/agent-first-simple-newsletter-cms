import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";
import { runSchedulerTick } from "../../src/services/scheduler.js";

// Onda E: Campagne clone API — broadcast, scheduling, templates, subscriptions.
describe("Onda E — Campagne clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let contact;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    // Auth REALE via dialetto moderno: Bearer api-key COMPLETA + locationId
    // in query (numeric → sites.id). NB: il prefisso del token NON valida
    // (l'hash è sul raw intero) e createTestSite non ritorna external_id.
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = res.ok ? await res.json() : null;
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Campaigns Clone");
    apiKey = await mkKey(site.id, "test key");

    // Crea contatto di test
    const contactEmail = `contact-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const contactResult = await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
      [site.id, contactEmail]
    );
    contact = { id: contactResult.rows[0].id, externalId: contactResult.rows[0].external_id };
    if (!contact.externalId) {
      const extResult = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
      contact.externalId = extResult.rows[0].external_id;
    }

    // Crea app express
    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  // ── Campagne ──────────────────────────────────────────────────────────

  test("Campagna: create → list meta → get → schedule → unschedule → delete", async () => {
    // Create
    const createRes = await fetch("/campaigns", {
      method: "POST",
      body: JSON.stringify({ name: "Campaign 1", subject: "Test Subject", content: "<p>Test</p>" }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.campaign);
    assert(createRes.data.campaign.id);
    assert.equal(createRes.data.campaign.name, "Campaign 1");
    assert.equal(createRes.data.campaign.status, "draft");
    const campaignId = createRes.data.campaign.id;

    // List con meta
    const listRes = await fetch("/campaigns");
    assert.equal(listRes.status, 200);
    assert(listRes.data.campaigns);
    assert(listRes.data.meta);
    assert(typeof listRes.data.meta.total === "number");
    assert.ok(listRes.data.meta.total >= 1);

    // Get
    const getRes = await fetch(`/campaigns/${campaignId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.campaign.id, campaignId);

    // Schedule (future)
    const futureDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const scheduleRes = await fetch(`/campaigns/${campaignId}`, {
      method: "PUT",
      body: JSON.stringify({ scheduledAt: futureDate }),
      headers: { "X-Patch-Op": "schedule" },
    });
    // Nota: l'endpoint corretto è PUT /campaigns/{id}/schedule
    const scheduleRes2 = await fetch(`/campaigns/${campaignId}/schedule`, {
      method: "PUT",
      body: JSON.stringify({ scheduledAt: futureDate }),
    });
    assert.equal(scheduleRes2.status, 200);
    assert.equal(scheduleRes2.data.campaign.status, "scheduled");
    assert(scheduleRes2.data.campaign.scheduledAt);

    // Unschedule
    const unscheduleRes = await fetch(`/campaigns/${campaignId}/unschedule`, {
      method: "POST",
    });
    assert.equal(unscheduleRes.status, 200);
    assert.equal(unscheduleRes.data.campaign.status, "draft");
    assert.equal(unscheduleRes.data.campaign.scheduledAt, null);

    // Delete
    const deleteRes = await fetch(`/campaigns/${campaignId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);
  });

  // ── Template ──────────────────────────────────────────────────────────

  test("Template: create → list → get → update → delete", async () => {
    // Create
    const createRes = await fetch("/templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Template 1",
        type: "Email",
        subject: "Welcome",
        bodyHtml: "<p>Hello {{name}}</p>",
      }),
    });
    assert.equal(createRes.status, 201);
    const template = createRes.data.template;
    assert(template.id);
    assert.equal(template.type, "Email");
    const templateId = template.id;

    // List
    const listRes = await fetch("/templates?type=Email");
    assert.equal(listRes.status, 200);
    assert(listRes.data.templates);
    assert(listRes.data.meta);

    // Get
    const getRes = await fetch(`/templates/${templateId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.template.id, templateId);

    // Update
    const updateRes = await fetch(`/templates/${templateId}`, {
      method: "PUT",
      body: JSON.stringify({ subject: "Updated Subject" }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.template.subject, "Updated Subject");

    // Delete
    const deleteRes = await fetch(`/templates/${templateId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);
  });

  // ── Subscriptions ─────────────────────────────────────────────────────

  test("Subscription: add → list → remove → removeAll", async () => {
    // Create campagna
    const campRes = await fetch("/campaigns", {
      method: "POST",
      body: JSON.stringify({ name: "Sub Test", subject: "Sub", content: "Test" }),
    });
    const campaignId = campRes.data.campaign.id;

    // Add subscription
    const addRes = await fetch(`/contacts/${contact.externalId}/campaigns/${campaignId}`, {
      method: "POST",
    });
    assert.equal(addRes.status, 201);
    assert(addRes.data.subscription);
    assert.equal(addRes.data.subscription.status, "active");

    // List contatto's campaigns
    const listRes = await fetch(`/contacts/${contact.externalId}/campaigns`);
    assert.equal(listRes.status, 200);
    assert(listRes.data.campaigns);
    assert.ok(listRes.data.campaigns.length >= 1);
    assert(listRes.data.campaigns[0].addedAt);

    // Remove one
    const removeRes = await fetch(`/contacts/${contact.externalId}/campaigns/${campaignId}`, {
      method: "DELETE",
    });
    assert.equal(removeRes.status, 200);
    assert.equal(removeRes.data.deleted, true);

    // Add again
    await fetch(`/contacts/${contact.externalId}/campaigns/${campaignId}`, {
      method: "POST",
    });

    // RemoveAll
    const removeAllRes = await fetch(`/contacts/${contact.externalId}/campaigns/removeAll`, {
      method: "DELETE",
    });
    assert.equal(removeAllRes.status, 200);
    assert(typeof removeAllRes.data.removed === "number");
  });

  // ── Scheduler ─────────────────────────────────────────────────────────

  test("Scheduler: campagna scheduled con passato → tick → status sending", async () => {
    // Create campagna con scheduled_at nel passato
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    const campRes = await fetch("/campaigns", {
      method: "POST",
      body: JSON.stringify({ name: "Scheduled Past", subject: "Past", content: "Body" }),
    });
    const campaignId = campRes.data.campaign.id;

    // Manualmente inserisci il scheduled_at nel passato (usa query diretta)
    const campRow = await query(
      "SELECT id FROM newsletter_campaigns WHERE external_id = $1",
      [campaignId]
    );
    const campIdSerial = campRow.rows[0].id;

    await query(
      "UPDATE newsletter_campaigns SET status = 'scheduled', scheduled_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [campIdSerial]
    );

    // Run tick
    await runSchedulerTick();

    // Verifica status → sending
    const checkRes = await fetch(`/campaigns/${campaignId}`);
    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.data.campaign.status, "sending");
  });
});
