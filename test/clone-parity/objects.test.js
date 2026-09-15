import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

describe("Onda H — Objects clone API", () => {
  let server, baseUrl;
  let site;
  let apiKey;

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
    site = await createTestSite("Objects Clone");
    apiKey = await mkKey(site.id, "test key");

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

  // ── Object Definitions ─────────────────────────────────────────────────

  test("Objects: definition create → list → get → update → delete", async () => {
    // Create
    const createRes = await fetch("/objects", {
      method: "POST",
      body: JSON.stringify({
        objectKey: "property",
        pluralLabel: "Properties",
        primaryField: "name",
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.objectDefinition);
    assert(createRes.data.objectDefinition.id);
    assert.equal(createRes.data.objectDefinition.objectKey, "property");
    assert.equal(createRes.data.objectDefinition.pluralLabel, "Properties");
    assert.equal(createRes.data.objectDefinition.primaryField, "name");
    assert(createRes.data.objectDefinition.dateAdded);
    assert(createRes.data.objectDefinition.dateUpdated);
    const defId = createRes.data.objectDefinition.id;

    // List
    const listRes = await fetch("/objects");
    assert.equal(listRes.status, 200);
    assert(listRes.data.objectDefinitions);
    assert(Array.isArray(listRes.data.objectDefinitions));
    assert(listRes.data.meta);
    assert.equal(typeof listRes.data.meta.total, "number");
    assert(listRes.data.objectDefinitions.some((d) => d.id === defId));

    // Get
    const getRes = await fetch(`/objects/${defId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.objectDefinition.id, defId);

    // Update
    const updateRes = await fetch(`/objects/${defId}`, {
      method: "PUT",
      body: JSON.stringify({ pluralLabel: "Real Estate" }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.objectDefinition.pluralLabel, "Real Estate");

    // Delete
    const delRes = await fetch(`/objects/${defId}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);

    // Verify deleted
    const getAfterDel = await fetch(`/objects/${defId}`);
    assert.equal(getAfterDel.status, 404);
  });

  test("Objects: records CRUD complete", async () => {
    // Create definition
    const defRes = await fetch("/objects", {
      method: "POST",
      body: JSON.stringify({
        objectKey: "vehicle",
        pluralLabel: "Vehicles",
        primaryField: "make",
      }),
    });
    const defId = defRes.data.objectDefinition.id;

    // Create record
    const createRecRes = await fetch(`/objects/${defId}/records`, {
      method: "POST",
      body: JSON.stringify({
        data: { make: "Toyota", model: "Camry", year: 2023 },
      }),
    });
    assert.equal(createRecRes.status, 201);
    assert(createRecRes.data.record);
    assert(createRecRes.data.record.id);
    assert.equal(createRecRes.data.record.objectKey, "vehicle");
    assert.deepEqual(createRecRes.data.record.data, { make: "Toyota", model: "Camry", year: 2023 });
    assert(createRecRes.data.record.dateAdded);
    assert(createRecRes.data.record.dateUpdated);
    const recordId = createRecRes.data.record.id;

    // List records
    const listRecRes = await fetch(`/objects/${defId}/records`);
    assert.equal(listRecRes.status, 200);
    assert(listRecRes.data.records);
    assert(Array.isArray(listRecRes.data.records));
    assert(listRecRes.data.meta);
    assert(listRecRes.data.records.some((r) => r.id === recordId));

    // Get record
    const getRecRes = await fetch(`/objects/${defId}/records/${recordId}`);
    assert.equal(getRecRes.status, 200);
    assert.equal(getRecRes.data.record.id, recordId);

    // Update record (merge)
    const updateRecRes = await fetch(`/objects/${defId}/records/${recordId}`, {
      method: "PUT",
      body: JSON.stringify({ data: { color: "red" } }),
    });
    assert.equal(updateRecRes.status, 200);
    assert.equal(updateRecRes.data.record.data.make, "Toyota"); // Merged
    assert.equal(updateRecRes.data.record.data.color, "red"); // New field

    // Delete record
    const delRecRes = await fetch(`/objects/${defId}/records/${recordId}`, {
      method: "DELETE",
    });
    assert.equal(delRecRes.status, 200);
    assert.equal(delRecRes.data.deleted, true);

    // Verify deleted
    const getAfterDel = await fetch(`/objects/${defId}/records/${recordId}`);
    assert.equal(getAfterDel.status, 404);
  });

  test("Objects: associations add/list/remove", async () => {
    // Create definition
    const defRes = await fetch("/objects", {
      method: "POST",
      body: JSON.stringify({ objectKey: "part", pluralLabel: "Parts" }),
    });
    const defId = defRes.data.objectDefinition.id;

    // Create 2 records
    const rec1Res = await fetch(`/objects/${defId}/records`, {
      method: "POST",
      body: JSON.stringify({ data: { name: "Engine" } }),
    });
    const rec1Id = rec1Res.data.record.id;

    const rec2Res = await fetch(`/objects/${defId}/records`, {
      method: "POST",
      body: JSON.stringify({ data: { name: "Transmission" } }),
    });
    const rec2Id = rec2Res.data.record.id;

    // Create association
    const assocRes = await fetch(`/objects/${defId}/records/${rec1Id}/associations`, {
      method: "POST",
      body: JSON.stringify({ toRecordId: rec2Id, relation: "powers" }),
    });
    assert.equal(assocRes.status, 201);
    assert(assocRes.data.association);
    assert.equal(assocRes.data.association.relation, "powers");

    // List associations
    const listAssocRes = await fetch(`/objects/${defId}/records/${rec1Id}/associations`);
    assert.equal(listAssocRes.status, 200);
    assert(Array.isArray(listAssocRes.data.associations));
    assert(listAssocRes.data.associations.some((a) => a.toRecordId === rec2Id));

    // List with relation filter
    const filterRes = await fetch(
      `/objects/${defId}/records/${rec1Id}/associations?relation=powers`
    );
    assert.equal(filterRes.status, 200);
    assert.equal(filterRes.data.associations.length, 1);
    assert.equal(filterRes.data.associations[0].relation, "powers");

    // Remove association
    const delAssocRes = await fetch(
      `/objects/${defId}/records/${rec1Id}/associations/${rec2Id}?relation=powers`,
      { method: "DELETE" }
    );
    assert.equal(delAssocRes.status, 200);
    assert.equal(delAssocRes.data.deleted, true);

    // Verify removed
    const listAfter = await fetch(`/objects/${defId}/records/${rec1Id}/associations`);
    assert.equal(listAfter.data.associations.length, 0);
  });

  test("Objects: create returns 400 without objectKey", async () => {
    const res = await fetch("/objects", {
      method: "POST",
      body: JSON.stringify({ pluralLabel: "Test" }),
    });
    assert.equal(res.status, 400);
  });

  test("Objects: get invalid UUID returns 400", async () => {
    const res = await fetch("/objects/invalid-uuid");
    assert.equal(res.status, 400);
  });

  test("Objects: get non-existent definition returns 404", async () => {
    const res = await fetch("/objects/12345678-1234-1234-1234-123456789012");
    assert.equal(res.status, 404);
  });

  test("Objects: records list pagination", async () => {
    // Create definition
    const defRes = await fetch("/objects", {
      method: "POST",
      body: JSON.stringify({ objectKey: "item" }),
    });
    const defId = defRes.data.objectDefinition.id;

    // Create 5 records
    const recIds = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`/objects/${defId}/records`, {
        method: "POST",
        body: JSON.stringify({ data: { name: `Item ${i}` } }),
      });
      recIds.push(res.data.record.id);
    }

    // List with limit 2
    const list1 = await fetch(`/objects/${defId}/records?limit=2`);
    assert.equal(list1.status, 200);
    assert(list1.data.records.length <= 2);
    assert.equal(list1.data.meta.total, 5);

    // Pagination
    if (list1.data.meta.nextPage) {
      const list2 = await fetch(
        `/objects/${defId}/records?limit=2&startAfterId=${list1.data.meta.nextPage}`
      );
      assert.equal(list2.status, 200);
      const ids1 = list1.data.records.map((r) => r.id);
      const ids2 = list2.data.records.map((r) => r.id);
      const intersection = ids1.filter((id) => ids2.includes(id));
      assert.equal(intersection.length, 0);
    }
  });
});
