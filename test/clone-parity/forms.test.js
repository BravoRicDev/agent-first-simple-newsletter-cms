import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda C: Forms clone API — contratto camelCase, UUID esterni,
// paginazione cursore, linkage formId/contactId.
describe("Onda C — Forms clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let contact;
  let form;
  let submission1;
  let submission2;

  before(async () => {
    site = await createTestSite("Forms Clone");

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

    // Crea contatto di test (per linkage submission)
    const contactEmail = `contact-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const contactResult = await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
      [site.id, contactEmail]
    );
    contact = { id: contactResult.rows[0].id, externalId: contactResult.rows[0].external_id, email: contactEmail };
    if (!contact.externalId) {
      const extResult = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
      contact.externalId = extResult.rows[0].external_id;
    }

    // Crea form di test
    const formResult = await query(
      "INSERT INTO forms (site_id, slug, name, fields) VALUES ($1, $2, $3, '[]') RETURNING id, external_id",
      [site.id, "test-form", "Test Form"]
    );
    form = { id: formResult.rows[0].id, externalId: formResult.rows[0].external_id };
    if (!form.externalId) {
      const extResult = await query("SELECT external_id FROM forms WHERE id = $1", [form.id]);
      form.externalId = extResult.rows[0].external_id;
    }

    // Crea submissions di test
    // Submission 1: con email che corrisponde al contatto
    const sub1Result = await query(
      `INSERT INTO form_submissions (site_id, form_slug, data, form_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, external_id`,
      [site.id, "test-form", JSON.stringify({ email: contactEmail, firstName: "Mario", lastName: "Rossi" }), form.id]
    );
    submission1 = { id: sub1Result.rows[0].id, externalId: sub1Result.rows[0].external_id };
    if (!submission1.externalId) {
      const extResult = await query("SELECT external_id FROM form_submissions WHERE id = $1", [submission1.id]);
      submission1.externalId = extResult.rows[0].external_id;
    }

    // Submission 2: email non corrispondente
    const sub2Result = await query(
      `INSERT INTO form_submissions (site_id, form_slug, data, form_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, external_id`,
      [site.id, "test-form", JSON.stringify({ email: "unknown@test.local", firstName: "John", lastName: "Doe" }), form.id]
    );
    submission2 = { id: sub2Result.rows[0].id, externalId: sub2Result.rows[0].external_id };
    if (!submission2.externalId) {
      const extResult = await query("SELECT external_id FROM form_submissions WHERE id = $1", [submission2.id]);
      submission2.externalId = extResult.rows[0].external_id;
    }

    // Backfill contact_id per submission1 (deve matchare)
    await query(
      `UPDATE form_submissions
       SET contact_id = $1
       WHERE id = $2 AND contact_id IS NULL`,
      [contact.id, submission1.id]
    );

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

    // Auth: wrapper fetch che aggiunge Bearer + locationId
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

  test("POST /forms — crea modulo", async () => {
    const res = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nuovo Modulo" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.form);
    assert.ok(body.form.id);
    assert.equal(body.form.name, "Nuovo Modulo");
    assert.ok(body.form.dateAdded);
    assert.ok(body.form.dateUpdated);
  });

  test("GET /forms — lista moduli con paginazione", async () => {
    const res = await fetch(`${baseUrl}/forms?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.forms));
    assert.ok(body.meta);
    assert.equal(typeof body.meta.total, "number");
    assert.ok(body.meta.total > 0);
    assert.ok(body.forms.some(f => f.id === form.externalId));
  });

  test("GET /forms/:id — ottiene modulo", async () => {
    const res = await fetch(`${baseUrl}/forms/${form.externalId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.form.id, form.externalId);
    assert.equal(body.form.name, "Test Form");
  });

  test("PUT /forms/:id — aggiorna modulo", async () => {
    const res = await fetch(`${baseUrl}/forms/${form.externalId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Form Aggiornato" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.form.name, "Test Form Aggiornato");
  });

  test("DELETE /forms/:id — cancella modulo (solo definizione)", async () => {
    // Crea un modulo per eliminarlo
    const createRes = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Modulo da Eliminare" }),
    });
    const created = (await createRes.json()).form;

    // Cancella
    const delRes = await fetch(`${baseUrl}/forms/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const body = await delRes.json();
    assert.equal(body.deleted, true);

    // Verifica 404 dopo delete
    const getRes = await fetch(`${baseUrl}/forms/${created.id}`);
    assert.equal(getRes.status, 404);
  });

  test("GET /forms/submissions — lista submissions con linkage", async () => {
    const res = await fetch(`${baseUrl}/forms/submissions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.submissions));
    assert.ok(body.meta);
    assert.equal(typeof body.meta.total, "number");
    assert.ok(body.meta.total >= 2);

    // Verifica che submission1 ha formId e contactId valorizzati
    const sub1 = body.submissions.find(s => s.id === submission1.externalId);
    assert.ok(sub1);
    assert.equal(sub1.formId, form.externalId);
    assert.equal(sub1.contactId, contact.externalId);
    assert.equal(sub1.name, "Mario Rossi");
    assert.ok(sub1.submission.email);

    // Verifica che submission2 ha formId ma contactId null
    const sub2 = body.submissions.find(s => s.id === submission2.externalId);
    assert.ok(sub2);
    assert.equal(sub2.formId, form.externalId);
    assert.equal(sub2.contactId, null);
    assert.equal(sub2.name, "John Doe");
  });

  test("GET /forms/submissions?formIds=<uuid> — filtra per form", async () => {
    const res = await fetch(`${baseUrl}/forms/submissions?formIds=${form.externalId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.submissions));
    // Tutte le submissions devono essere della form specificata
    body.submissions.forEach(s => {
      assert.equal(s.formId, form.externalId);
    });
  });

  test("GET /forms/submissions?startDate=<iso> — filtra per data inizio", async () => {
    // Usa una data futura per avere 0 risultati
    const futureDate = new Date(new Date().getTime() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await fetch(`${baseUrl}/forms/submissions?startDate=${futureDate}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.submissions));
    assert.equal(body.submissions.length, 0);
    assert.equal(body.meta.total, 0);
  });

  test("POST /forms — slug autogenerato univoco", async () => {
    const name = "Modulo Contatti";
    // Crea due form con lo stesso nome
    const res1 = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const form1 = (await res1.json()).form;
    assert.ok(form1.id);

    const res2 = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const form2 = (await res2.json()).form;
    assert.ok(form2.id);

    // Gli ID devono essere diversi (slug diverso)
    assert.notEqual(form1.id, form2.id);
  });

  // Parity ghl_id: round-trip su form (submission id reale esposto quando
  // presente, id malformato/inesistente gestiti correttamente).
  test("Parity ghl_id: round-trip GET/PUT/DELETE form col ghl_id reale", async () => {
    const createRes = await fetch(`${baseUrl}/forms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RtForm" }),
    });
    const created = (await createRes.json()).form;
    assert.ok(created.id, "uuid assente");

    const realGhlId = "ghlFORMparity001";
    await query(`UPDATE forms SET ghl_id = $1 WHERE external_id = $2`, [realGhlId, created.id]);

    const getRes = await fetch(`${baseUrl}/forms/${realGhlId}`);
    assert.equal(getRes.status, 200);
    const got = (await getRes.json()).form;
    assert.equal(got.id, realGhlId, "id risposta deve essere il ghl_id reale");

    const putRes = await fetch(`${baseUrl}/forms/${realGhlId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RtFormUpdated" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal((await putRes.json()).form.name, "RtFormUpdated");

    const deleteRes = await fetch(`${baseUrl}/forms/${realGhlId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);

    const getAfterDel = await fetch(`${baseUrl}/forms/${realGhlId}`);
    assert.equal(getAfterDel.status, 404);
  });

  test("Parity ghl_id: id form malformato (300 char) → 400", async () => {
    const res = await fetch(`${baseUrl}/forms/${"x".repeat(300)}`);
    assert.equal(res.status, 400);
  });

  test("Parity ghl_id: id form formato valido ma inesistente → 404", async () => {
    const res = await fetch(`${baseUrl}/forms/nonexistent-ghl-id`);
    assert.equal(res.status, 404);
  });

  test("Parity ghl_id: submission espone formId/contactId reali quando presenti", async () => {
    const realFormGhlId = "ghlFORMforsub001";
    const realContactGhlId = "ghlCONTACTforsub001";
    await query(`UPDATE forms SET ghl_id = $1 WHERE id = $2`, [realFormGhlId, form.id]);
    await query(`UPDATE contacts SET ghl_id = $1 WHERE id = $2`, [realContactGhlId, contact.id]);

    const res = await fetch(`${baseUrl}/forms/submissions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const sub = body.submissions.find((s) => s.id === submission1.externalId);
    assert.ok(sub, "submission1 deve essere in lista");
    assert.equal(sub.formId, realFormGhlId);
    assert.equal(sub.contactId, realContactGhlId);
  });
});
