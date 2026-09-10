import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import apiCloneRouter from "../../src/routes/api-clone/index.js";

describe("Clone API — Custom Fields (Onda A)", () => {
  let server, baseUrl;
  let siteA;
  let apiKeyA;

  before(async () => {
    siteA = await createTestSite("Custom Fields Test Site");
    const locationUuid = crypto.randomUUID();
    await query(
      "UPDATE sites SET location_external_id = $1 WHERE id = $2",
      [locationUuid, siteA.id]
    );
    siteA.locationExternalId = locationUuid;

    const mk = async (siteId, name) => {
      const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const r = await query(
        "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
        [siteId, name, hash, raw.slice(0, 12)]
      );
      return { id: r.rows[0].id, raw };
    };
    apiKeyA = await mk(siteA.id, "cf-key");

    const app = express();
    app.use(express.json());
    app.use("/api", apiCloneRouter);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}/api`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = () => ({
    Authorization: `Bearer ${apiKeyA.raw}`,
    "Content-Type": "application/json",
  });

  const url = (path) => {
    const sep = path.includes("?") ? "&" : "?";
    return `${baseUrl}${path}${sep}locationId=${siteA.id}`;
  };

  test("POST /custom-fields crea TEXT field", async () => {
    const res = await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Company Phone",
        dataType: "TEXT",
        objectKey: "contact",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.customField);
    assert.equal(body.customField.name, "Company Phone");
    assert.equal(body.customField.dataType, "TEXT");
    assert.equal(body.customField.fieldKey, "company_phone");
    assert.ok(body.customField.id);
    assert.equal(body.customField.locationId, siteA.locationExternalId);
    assert.ok(Array.isArray(body.customField.options));
  });

  test("POST /custom-fields crea DROPDOWN field con options", async () => {
    const res = await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Service Type",
        dataType: "DROPDOWN",
        objectKey: "contact",
        options: ["Premium", "Standard"],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.customField.dataType, "DROPDOWN");
    assert.ok(Array.isArray(body.customField.options));
    assert.equal(body.customField.options.length, 2);
  });

  test("POST /custom-fields 400 dataType invalido", async () => {
    const res = await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Bad Field",
        dataType: "INVALID_TYPE",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /DataType/i);
  });

  test("GET /custom-fields lista contact fields per default", async () => {
    await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Field1",
        dataType: "TEXT",
        objectKey: "contact",
      }),
    });
    await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Field2",
        dataType: "NUMERIC",
        objectKey: "contact",
      }),
    });

    const res = await fetch(url("/custom-fields"), {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.customFields));
    assert.ok(body.meta);
    assert.ok(typeof body.meta.total === "number");
  });

  test("GET /custom-fields filtra per objectKey", async () => {
    await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "OpField",
        dataType: "TEXT",
        objectKey: "opportunity",
      }),
    });

    const resContact = await fetch(url("/custom-fields?objectKey=contact"), {
      headers: auth(),
    });
    const contactFields = (await resContact.json()).customFields;

    const resOpp = await fetch(url("/custom-fields?objectKey=opportunity"), {
      headers: auth(),
    });
    const oppFields = (await resOpp.json()).customFields;

    assert.ok(contactFields.every(f => f !== undefined));
    assert.ok(oppFields.some(f => f.name === "OpField"));
    assert.ok(!contactFields.some(f => f.name === "OpField"));
  });

  test("GET /custom-fields/:id ottiene field per uuid", async () => {
    const createRes = await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "GetFieldTest",
        dataType: "TEXT",
      }),
    });
    const created = (await createRes.json()).customField;
    const fieldId = created.id;

    const res = await fetch(url(`/custom-fields/${fieldId}`), {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.customField.id, fieldId);
    assert.equal(body.customField.name, "GetFieldTest");
  });

  test("PUT /custom-fields/:id aggiorna name e dataType", async () => {
    const createRes = await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "UpdateFieldTest",
        dataType: "TEXT",
      }),
    });
    const created = (await createRes.json()).customField;
    const fieldId = created.id;

    const updateRes = await fetch(url(`/custom-fields/${fieldId}`), {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({
        name: "UpdatedFieldName",
        dataType: "NUMERIC",
      }),
    });
    assert.equal(updateRes.status, 200);
    const updated = (await updateRes.json()).customField;
    assert.equal(updated.name, "UpdatedFieldName");
    assert.equal(updated.dataType, "NUMERIC");
  });

  test("DELETE /custom-fields/:id elimina field", async () => {
    const createRes = await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "DeleteFieldTest",
        dataType: "TEXT",
      }),
    });
    const created = (await createRes.json()).customField;
    const fieldId = created.id;

    const deleteRes = await fetch(url(`/custom-fields/${fieldId}`), {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(deleteRes.status, 200);
    const deleted = await deleteRes.json();
    assert.equal(deleted.deleted, true);

    const getRes = await fetch(url(`/custom-fields/${fieldId}`), {
      headers: auth(),
    });
    assert.equal(getRes.status, 404);
  });

  test("POST /custom-fields/folder crea folder", async () => {
    const res = await fetch(url("/custom-fields/folder"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Customer Info" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.folder);
    assert.equal(body.folder.name, "Customer Info");
    assert.ok(body.folder.id);
    assert.ok(body.folder.dateAdded);
  });

  test("GET /custom-fields/folder lista folder", async () => {
    await fetch(url("/custom-fields/folder"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Folder1" }),
    });

    const res = await fetch(url("/custom-fields/folder"), {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.folders));
    assert.ok(body.meta);
  });

  test("DELETE /custom-fields/folder/:id elimina folder", async () => {
    const createRes = await fetch(url("/custom-fields/folder"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "DeleteFolderTest" }),
    });
    const created = (await createRes.json()).folder;
    const folderId = created.id;

    const deleteRes = await fetch(url(`/custom-fields/folder/${folderId}`), {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(deleteRes.status, 200);
    const deleted = await deleteRes.json();
    assert.equal(deleted.deleted, true);
  });

  // Parity ghl_id: round-trip su custom field (le folder NON hanno ghl_id,
  // sono una feature puramente locale mai sincronizzata da GHL — nessun fix
  // necessario lì).
  test("Parity ghl_id: round-trip GET/PUT/DELETE col ghl_id reale + id esposto", async () => {
    const createRes = await fetch(url("/custom-fields"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "RtField", dataType: "TEXT" }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()).customField;
    assert.ok(created.id, "uuid assente");

    const realGhlId = "ghlFIELDparity001";
    await query(`UPDATE custom_fields SET ghl_id = $1 WHERE external_id = $2`, [realGhlId, created.id]);

    const getRes = await fetch(url(`/custom-fields/${realGhlId}`), { headers: auth() });
    assert.equal(getRes.status, 200);
    const got = (await getRes.json()).customField;
    assert.equal(got.id, realGhlId, "id risposta deve essere il ghl_id reale");

    const putRes = await fetch(url(`/custom-fields/${realGhlId}`), {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ name: "RtFieldUpdated" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal((await putRes.json()).customField.name, "RtFieldUpdated");

    const deleteRes = await fetch(url(`/custom-fields/${realGhlId}`), {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(deleteRes.status, 200);

    const getAfterDel = await fetch(url(`/custom-fields/${realGhlId}`), { headers: auth() });
    assert.equal(getAfterDel.status, 404);
  });

  test("Parity ghl_id: id malformato (300 char) → 400", async () => {
    const res = await fetch(url(`/custom-fields/${"x".repeat(300)}`), { headers: auth() });
    assert.equal(res.status, 400);
  });

  test("Parity ghl_id: id formato valido ma inesistente → 404", async () => {
    const res = await fetch(url("/custom-fields/nonexistent-ghl-id"), { headers: auth() });
    assert.equal(res.status, 404);
  });

  // ── Round 18: CUSTOM VALUES dentro GET /custom-fields ─────────────────
  // GHL serve i custom values nella STESSA risposta di GET /customFields/
  // (chiave `customValues`). ghl_custom_values è mirror del sorgente:
  // nessun external_id proprio → id = ghl_id reale, niente doppio id.
  // Nessun endpoint separato /customValues/:id in GHL → niente da fixare
  // in lettura singola; POST/PUT/DELETE values non esposti (motivi nel
  // commit: tabella mirror senza id scrivibile stabile + sorgente account
  // con 0 valori, impossibile verificare una scrittura contro il reale).

  test("Round 18: GET /custom-fields include customValues con ghl_id reale e scope per sito", async () => {
    const other = await createTestSite("CF Values Other");

    // ghl_id casuali per run: il volume di test persiste tra esecuzioni e
    // ghl_custom_values ha UNIQUE(site_id, ghl_id)
    const cv1Id = "cvA" + crypto.randomBytes(8).toString("hex");
    const cv2Id = "cvB" + crypto.randomBytes(8).toString("hex");
    const cvOtherId = "cvX" + crypto.randomBytes(8).toString("hex");

    // 2 valori sul nostro sito (ghl_id reali stile GHL) + 1 su altro sito
    await query(
      `INSERT INTO ghl_custom_values (site_id, ghl_id, name, value)
       VALUES ($1, $2, $3, $4), ($1, $5, $6, $7), ($8, $9, $10, $11)`,
      [
        siteA.id, cv1Id, "Provenienza", "Annuncio FB",
        cv2Id, "Fonte", "Referral",
        other.id, cvOtherId, "Non deve vedersi", "x",
      ]
    );

    const res = await fetch(url("/custom-fields"), { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();

    // customFields continua a rispondere (nessuna regressione) + meta
    assert(Array.isArray(body.customFields));
    assert(body.meta);

    // customValues presente, SOLO valori del proprio sito, id = ghl_id reale
    assert(Array.isArray(body.customValues), "chiave customValues sempre presente (come GHL)");
    assert.equal(body.customValues.length, 2, "solo i valori del sito corrente");
    const v1 = body.customValues.find((v) => v.id === cv1Id);
    assert.ok(v1, "valore presente con ghl_id REALE come id");
    assert.equal(v1.name, "Provenienza");
    assert.equal(v1.value, "Annuncio FB");
    assert.equal(
      body.customValues.some((v) => v.id === cvOtherId),
      false,
      "valore di altro sito NON visibile"
    );
  });
});
