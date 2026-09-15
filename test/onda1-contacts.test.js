import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import v1Routes from "../src/routes/v1.js";

// ONDA 1 — Contatti sulla surface /v1 (CRUD/search/upsert/note/tags/tasks/
// custom fields/duplicate/isolamento tenant).
describe("ONDA 1 — contatti API /v1", () => {
  let server, baseUrl;
  let siteA, siteB;
  let apiKeyA, apiKeyB;

  before(async () => {
    siteA = await createTestSite("O1 Tenant A");
    siteB = await createTestSite("O1 Tenant B");

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

    // Custom field per-tenant su A (object contact) per testare il mapping.
    await query(
      `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, active)
       VALUES ($1, 'contact', 'citta', 'Città', 'text', true),
              ($1, 'contact', 'budget', 'Budget', 'number', true)`,
      [siteA.id]
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

  test("401 senza credenziali", async () => {
    const res = await fetch(`${baseUrl}/v1/contacts`, { headers: { "Location-Id": String(siteA.id) } });
    assert.equal(res.status, 401);
  });

  test("POST/GET/PUT/DELETE contatto + custom fields + isolamento", async () => {
    // Crea su A
    const createRes = await postJson(`${baseUrl}/v1/contacts`, {
      email: "mario@example.test", name: "Mario Rossi",
      phone: "+391234567", companyName: "ACME Spa", tags: ["lead", "web"],
      customFields: { citta: "Roma", budget: 1000 },
    }, auth(siteA.id, apiKeyA.raw));
    assert.equal(createRes.status, 201);
    const contact = (await createRes.json()).contact;
    assert.ok(Number.isInteger(contact.id));
    assert.equal(contact.email, "mario@example.test");
    assert.equal(contact.name, "Mario Rossi");
    assert.equal(contact.firstName, "Mario");
    assert.equal(contact.lastName, "Rossi");
    assert.deepEqual(contact.tags, ["lead", "web"]);
    // custom field mappato nel payload
    assert.equal(contact.customFields.citta, "Roma");
    assert.equal(contact.customFields.budget, 1000);

    // GET singolo
    const getRes = await fetch(`${baseUrl}/v1/contacts/${contact.id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(getRes.status, 200);
    assert.equal((await getRes.json()).contact.email, "mario@example.test");

    // PUT parziale
    const putRes = await fetch(`${baseUrl}/v1/contacts/${contact.id}`, {
      method: "PUT", headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mario Verdi", status: "proposta_inviata", customFields: { citta: "Milano" } }),
    });
    assert.equal(putRes.status, 200);
    const updated = (await putRes.json()).contact;
    assert.equal(updated.name, "Mario Verdi");
    assert.equal(updated.lastName, "Verdi");
    assert.equal(updated.status, "proposta_inviata");
    assert.equal(updated.customFields.citta, "Milano");

    // Isolamento: tenant B non vede il contatto di A
    const listB = await fetch(`${baseUrl}/v1/contacts`, { headers: auth(siteB.id, apiKeyB.raw) });
    const contactsB = (await listB.json()).contacts;
    assert.ok(!contactsB.some(c => c.email === "mario@example.test"));

    // DELETE
    const delRes = await fetch(`${baseUrl}/v1/contacts/${contact.id}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(delRes.status, 200);
    const getDel = await fetch(`${baseUrl}/v1/contacts/${contact.id}`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(getDel.status, 404);
  });

  test("upsert: create poi update (created true/false)", async () => {
    const email = "upsert@example.test";
    const r1 = await postJson(`${baseUrl}/v1/contacts/upsert`, { email, name: "Anna Bianchi", tags: ["x"] }, auth(siteA.id, apiKeyA.raw));
    assert.equal(r1.status, 201);
    const b1 = (await r1.json());
    assert.equal(b1.created, true);

    const r2 = await postJson(`${baseUrl}/v1/contacts/upsert`, { email, name: "Anna Neri" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(r2.status, 200);
    const b2 = (await r2.json());
    assert.equal(b2.created, false);
    assert.equal(b2.contact.name, "Anna Neri");
    // tag preservati all'update
    assert.deepEqual(b2.contact.tags, ["x"]);
  });

  test("search + duplicate", async () => {
    await postJson(`${baseUrl}/v1/contacts`, { email: "dup@example.test", name: "Pino", phone: "333111" }, auth(siteA.id, apiKeyA.raw));
    const s = await postJson(`${baseUrl}/v1/contacts/search`, { query: "dup" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(s.status, 200);
    assert.ok((await s.json()).contacts.some(c => c.email === "dup@example.test"));

    const d = await postJson(`${baseUrl}/v1/contacts/search/duplicate`, { email: "DUP@example.test" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(d.status, 200);
    const dupes = (await d.json()).duplicates;
    assert.ok(dupes.some(c => c.email === "dup@example.test"));
  });

  test("note CRUD", async () => {
    const r = await postJson(`${baseUrl}/v1/contacts`, { email: "note@example.test" }, auth(siteA.id, apiKeyA.raw));
    const cid = (await r.json()).contact.id;

    const n1 = await postJson(`${baseUrl}/v1/contacts/${cid}/notes`, { body: "prima nota" }, auth(siteA.id, apiKeyA.raw));
    assert.equal(n1.status, 201);
    const note = (await n1.json()).note;
    assert.equal(note.body, "prima nota");

    const list = await fetch(`${baseUrl}/v1/contacts/${cid}/notes`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).notes.length, 1);

    const del = await fetch(`${baseUrl}/v1/contacts/${cid}/notes/${note.id}`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(del.status, 200);
  });

  test("tags add/remove", async () => {
    const r = await postJson(`${baseUrl}/v1/contacts`, { email: "tag@example.test" }, auth(siteA.id, apiKeyA.raw));
    const cid = (await r.json()).contact.id;

    const add = await postJson(`${baseUrl}/v1/contacts/${cid}/tags`, { tags: ["a", "b"] }, auth(siteA.id, apiKeyA.raw));
    assert.equal(add.status, 200);
    assert.deepEqual((await add.json()).tags, ["a", "b"]);

    const get = await fetch(`${baseUrl}/v1/contacts/${cid}/tags`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.deepEqual((await get.json()).tags, ["a", "b"]);

    const rem = await fetch(`${baseUrl}/v1/contacts/${cid}/tags/a`, { method: "DELETE", headers: auth(siteA.id, apiKeyA.raw) });
    assert.deepEqual((await rem.json()).tags, ["b"]);
  });

  test("tasks create/list/complete", async () => {
    const r = await postJson(`${baseUrl}/v1/contacts`, { email: "task@example.test" }, auth(siteA.id, apiKeyA.raw));
    const cid = (await r.json()).contact.id;
    const user = await createTestUser(siteA.id, "collaboratore");

    const t1 = await postJson(`${baseUrl}/v1/contacts/${cid}/tasks`, { title: "chiama", notes: "subito", assigneeId: user.id }, auth(siteA.id, apiKeyA.raw));
    assert.equal(t1.status, 201);
    const task = (await t1.json()).task;
    assert.equal(task.title, "chiama");

    const list = await fetch(`${baseUrl}/v1/contacts/${cid}/tasks`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal((await list.json()).tasks.length, 1);

    const done = await fetch(`${baseUrl}/v1/contacts/${cid}/tasks/${task.id}`, {
      method: "PUT", headers: { ...auth(siteA.id, apiKeyA.raw), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).task.status, "done");
  });

  test("followers + campaigns + workflow (strutture v1)", async () => {
    const r = await postJson(`${baseUrl}/v1/contacts`, { email: "all@example.test" }, auth(siteA.id, apiKeyA.raw));
    const cid = (await r.json()).contact.id;

    const f = await fetch(`${baseUrl}/v1/contacts/${cid}/followers`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(f.status, 200);
    assert.deepEqual((await f.json()).followers, []);

    const c = await fetch(`${baseUrl}/v1/contacts/${cid}/campaigns`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(c.status, 200);
    assert.deepEqual((await c.json()).campaigns, []);

    const w = await fetch(`${baseUrl}/v1/contacts/${cid}/workflow`, { headers: auth(siteA.id, apiKeyA.raw) });
    assert.equal(w.status, 200);
    const wf = (await w.json()).workflow;
    assert.equal(wf.contact_id, cid);
    assert.ok(Array.isArray(wf.events));
  });
});
