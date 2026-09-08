import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda A: Opportunità clone API — contratto camelCase, UUID esterni,
// paginazione cursore, serializzazione stage/contactEmail.
describe("Onda A — Opportunità clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let contact;
  let user;
  let pipeline;

  before(async () => {
    site = await createTestSite("Opportunities Clone");

    // Crea API key
    const mkKey = async (siteId, name) => {
      const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const r = await query(
        "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
        [siteId, name, hash, raw.slice(0, 12)]
      );
      return { id: r.rows[0].id, raw };
    };
    apiKey = await mkKey(site.id, "test key");

    // Crea utente di test
    const userEmail = `user-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const userResult = await query(
      "INSERT INTO users (email, name, role, site_id, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id, external_id",
      [userEmail, "Test User", "admin", site.id]
    );
    user = { id: userResult.rows[0].id, externalId: userResult.rows[0].external_id, email: userEmail };
    // Ensure external_id
    if (!user.externalId) {
      const extResult = await query("SELECT external_id FROM users WHERE id = $1", [user.id]);
      user.externalId = extResult.rows[0].external_id;
    }

    // Crea contatto di test
    const contactEmail = `contact-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const contactResult = await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
      [site.id, contactEmail]
    );
    contact = { id: contactResult.rows[0].id, externalId: contactResult.rows[0].external_id, email: contactEmail };
    // Ensure external_id
    if (!contact.externalId) {
      const extResult = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
      contact.externalId = extResult.rows[0].external_id;
    }

    // Crea pipeline di test
    const pipelineResult = await query(
      "INSERT INTO pipelines (site_id, name, stages, is_default) VALUES ($1, $2, '[]', true) RETURNING id, external_id",
      [site.id, "Test Pipeline"]
    );
    pipeline = { id: pipelineResult.rows[0].id, externalId: pipelineResult.rows[0].external_id };
    // Ensure external_id
    if (!pipeline.externalId) {
      const extResult = await query("SELECT external_id FROM pipelines WHERE id = $1", [pipeline.id]);
      pipeline.externalId = extResult.rows[0].external_id;
    }

    // Crea app
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });

    // Auth REALE via dialetto moderno: wrappa fetch per aggiungere Bearer
    // api-key + locationId a OGNI richiesta (stesso percorso wire di un
    // client vero). Nota: iniettare i parametri su req.url NON funziona,
    // Express memoizza req.query all'inizio della request.
    const baseFetch = global.fetch;
    global.fetch = (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (!url.searchParams.has("locationId")) {
        url.searchParams.set("locationId", String(site.id));
      }
      init.headers = { Authorization: `Bearer ${apiKey.raw}`, ...(init.headers || {}) };
      return baseFetch(url, init);
    };
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  test("POST /opportunities — crea opportunità", async () => {
    const res = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Opportunity",
        contactId: contact.externalId,
        pipelineId: pipeline.externalId,
        status: "open",
        monetaryValue: 5000,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.opportunity);
    assert.ok(body.opportunity.id);
    assert.equal(body.opportunity.name, "Test Opportunity");
    assert.equal(body.opportunity.contactId, contact.externalId);
    assert.equal(body.opportunity.status, "open");
    assert.equal(body.opportunity.monetaryValue, 5000);
  });

  test("GET /opportunities — lista opportunità con paginazione", async () => {
    const res = await fetch(`${baseUrl}/opportunities?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.opportunities));
    assert.ok(body.meta);
    assert.equal(typeof body.meta.total, "number");
    assert.ok(body.meta.total > 0);
  });

  test("GET /opportunities/:id — ottiene opportunità", async () => {
    const createRes = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Get Test",
        contactId: contact.externalId,
        status: "open",
        monetaryValue: 1000,
      }),
    });
    const created = (await createRes.json()).opportunity;

    const getRes = await fetch(`${baseUrl}/opportunities/${created.id}`);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.equal(body.opportunity.id, created.id);
    assert.equal(body.opportunity.name, "Get Test");
  });

  test("PUT /opportunities/:id — aggiorna opportunità + last_status_change", async () => {
    const createRes = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Update Test",
        contactId: contact.externalId,
        status: "open",
        monetaryValue: 2000,
      }),
    });
    const created = (await createRes.json()).opportunity;

    const putRes = await fetch(`${baseUrl}/opportunities/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "won" }),
    });
    assert.equal(putRes.status, 200);
    const body = await putRes.json();
    assert.equal(body.opportunity.status, "won");
    assert.ok(body.opportunity.lastStatusChange); // Deve essere non-null
  });

  test("DELETE /opportunities/:id — cancella opportunità", async () => {
    const createRes = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Delete Test",
        contactId: contact.externalId,
        status: "open",
      }),
    });
    const created = (await createRes.json()).opportunity;

    const delRes = await fetch(`${baseUrl}/opportunities/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const body = await delRes.json();
    assert.equal(body.deleted, true);

    // Verifica 404 dopo delete
    const getRes = await fetch(`${baseUrl}/opportunities/${created.id}`);
    assert.equal(getRes.status, 404);
  });

  test("PUT /opportunities/:id/status — cambia solo status", async () => {
    const createRes = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Status Test",
        contactId: contact.externalId,
        status: "open",
      }),
    });
    const created = (await createRes.json()).opportunity;

    const statusRes = await fetch(`${baseUrl}/opportunities/${created.id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "lost" }),
    });
    assert.equal(statusRes.status, 200);
    const body = await statusRes.json();
    assert.equal(body.opportunity.status, "lost");
  });

  test("POST /opportunities/search — cerca opportunità con filtri", async () => {
    const searchRes = await fetch(`${baseUrl}/opportunities/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "open",
        limit: 5,
      }),
    });
    assert.equal(searchRes.status, 200);
    const body = await searchRes.json();
    assert.ok(Array.isArray(body.opportunities));
    assert.ok(body.meta);
  });

  test("POST /opportunities/upsert — crea o aggiorna per contactId+name", async () => {
    const upsertRes1 = await fetch(`${baseUrl}/opportunities/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactId: contact.externalId,
        name: "Upsert Test",
        monetaryValue: 3000,
      }),
    });
    assert.equal(upsertRes1.status, 201); // Prima upsert = creazione
    const first = (await upsertRes1.json()).opportunity;
    const firstId = first.id;
    assert.equal(first.status, "open"); // Default solo in creazione

    // Upsert di nuovo: deve aggiornare (non creare nuovo)
    const upsertRes2 = await fetch(`${baseUrl}/opportunities/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactId: contact.externalId,
        name: "Upsert Test",
        monetaryValue: 4000,
      }),
    });
    assert.equal(upsertRes2.status, 200);
    const second = (await upsertRes2.json()).opportunity;
    assert.equal(second.id, firstId); // Stesso ID
    assert.equal(second.monetaryValue, 4000); // Aggiornato
  });

  test("GET /opportunities/:id/followers — lista follower", async () => {
    const createRes = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Followers Test",
        contactId: contact.externalId,
      }),
    });
    const created = (await createRes.json()).opportunity;

    const followRes = await fetch(`${baseUrl}/opportunities/${created.id}/followers`);
    assert.equal(followRes.status, 200);
    const body = await followRes.json();
    assert.ok(Array.isArray(body.followers));
  });

  test("POST /opportunities/:id/followers — aggiungi follower", async () => {
    const createRes = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Add Follower Test",
        contactId: contact.externalId,
      }),
    });
    const created = (await createRes.json()).opportunity;

    const addRes = await fetch(`${baseUrl}/opportunities/${created.id}/followers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.externalId }),
    });
    assert.equal(addRes.status, 201);
    const body = await addRes.json();
    assert.ok(body.follower);
    assert.equal(body.follower.id, user.externalId);
  });

  test("DELETE /opportunities/:id/followers/:userId — rimuovi follower", async () => {
    const createRes = await fetch(`${baseUrl}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Remove Follower Test",
        contactId: contact.externalId,
      }),
    });
    const created = (await createRes.json()).opportunity;

    // Aggiungi
    await fetch(`${baseUrl}/opportunities/${created.id}/followers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.externalId }),
    });

    // Rimuovi
    const delRes = await fetch(`${baseUrl}/opportunities/${created.id}/followers/${user.externalId}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const body = await delRes.json();
    assert.equal(body.deleted, true);
  });

  test("GET /opportunities/lost-reason — leggi lost_reasons da config", async () => {
    const res = await fetch(`${baseUrl}/opportunities/lost-reason`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.lostReasons));
  });

  test("GET /pipelines — lista pipeline", async () => {
    const res = await fetch(`${baseUrl}/pipelines`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.pipelines));
    assert.ok(body.pipelines.length > 0);
  });

  test("POST /pipelines — crea pipeline con stages", async () => {
    const res = await fetch(`${baseUrl}/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New Pipeline",
        stages: [
          { name: "Prospecting" },
          { name: "Qualification" },
          { name: "Proposal" },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.pipeline);
    assert.ok(body.pipeline.id);
    assert.equal(body.pipeline.name, "New Pipeline");
    assert.equal(body.pipeline.stages.length, 3);
    // Verifica che ogni stage ha un id
    body.pipeline.stages.forEach((s) => {
      assert.ok(s.id);
      assert.equal(typeof s.name, "string");
    });
  });

  test("GET /pipelines/:id — ottiene pipeline", async () => {
    const createRes = await fetch(`${baseUrl}/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Get Pipeline Test",
        stages: [{ name: "Stage A" }],
      }),
    });
    const created = (await createRes.json()).pipeline;

    const getRes = await fetch(`${baseUrl}/pipelines/${created.id}`);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.equal(body.pipeline.id, created.id);
    assert.equal(body.pipeline.name, "Get Pipeline Test");
  });

  test("PUT /pipelines/:id — aggiorna pipeline", async () => {
    const createRes = await fetch(`${baseUrl}/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Update Pipeline Test",
        stages: [{ name: "Old Stage" }],
      }),
    });
    const created = (await createRes.json()).pipeline;

    const putRes = await fetch(`${baseUrl}/pipelines/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated Pipeline",
        stages: [{ name: "New Stage" }],
      }),
    });
    assert.equal(putRes.status, 200);
    const body = await putRes.json();
    assert.equal(body.pipeline.name, "Updated Pipeline");
  });

  test("DELETE /pipelines/:id — cancella pipeline", async () => {
    const createRes = await fetch(`${baseUrl}/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Delete Pipeline Test",
        stages: [],
      }),
    });
    const created = (await createRes.json()).pipeline;

    const delRes = await fetch(`${baseUrl}/pipelines/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const body = await delRes.json();
    assert.equal(body.deleted, true);
  });
});
