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
});
