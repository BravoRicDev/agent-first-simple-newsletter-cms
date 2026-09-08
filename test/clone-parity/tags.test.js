import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import apiCloneRouter from "../../src/routes/api-clone/index.js";

describe("Clone API — Tags (Onda A)", () => {
  let server, baseUrl;
  let siteA;
  let apiKeyA;

  before(async () => {
    siteA = await createTestSite("Tags Test Site");
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
    apiKeyA = await mk(siteA.id, "tag-key");

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

  const url = (path) => `${baseUrl}${path}?locationId=${siteA.id}`;

  test("POST /tags crea tag con nome e colore opzionale", async () => {
    const res = await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "VIP", color: "#FF0000" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.tag);
    assert.equal(body.tag.name, "VIP");
    assert.equal(body.tag.color, "#FF0000");
    assert.ok(body.tag.id, "uuid assente");
    assert.equal(body.tag.locationId, siteA.locationExternalId);
    assert.ok(body.tag.dateAdded);
  });

  test("POST /tags 409 su nome duplicato", async () => {
    await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Duplicate" }),
    });
    const res = await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Duplicate" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.statusCode, 409);
    assert.match(body.message, /già/i);
  });

  test("GET /tags lista con meta", async () => {
    await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Tag1" }),
    });
    await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Tag2" }),
    });

    const res = await fetch(url("/tags"), {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.tags));
    assert.ok(body.meta);
    assert.ok(typeof body.meta.total === "number");
    assert.equal(body.meta.total >= 2, true);
    assert.ok("nextPage" in body.meta);
  });

  test("GET /tags/:id ottiene tag per uuid", async () => {
    const createRes = await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "GetTest" }),
    });
    const created = (await createRes.json()).tag;
    const tagId = created.id;

    const res = await fetch(url(`/tags/${tagId}`), {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tag.id, tagId);
    assert.equal(body.tag.name, "GetTest");
  });

  test("GET /tags/:id 404 uuid inesistente", async () => {
    const fakeId = crypto.randomUUID();
    const res = await fetch(url(`/tags/${fakeId}`), {
      headers: auth(),
    });
    assert.equal(res.status, 404);
  });

  test("GET /tags/:id 400 uuid invalido", async () => {
    const res = await fetch(url("/tags/invalid-uuid"), {
      headers: auth(),
    });
    assert.equal(res.status, 400);
  });

  test("PUT /tags/:id aggiorna tag", async () => {
    const createRes = await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "UpdateTest", color: "#0000FF" }),
    });
    const created = (await createRes.json()).tag;
    const tagId = created.id;

    const updateRes = await fetch(url(`/tags/${tagId}`), {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ name: "UpdatedName", color: "#00FF00" }),
    });
    assert.equal(updateRes.status, 200);
    const updated = (await updateRes.json()).tag;
    assert.equal(updated.name, "UpdatedName");
    assert.equal(updated.color, "#00FF00");
  });

  test("DELETE /tags/:id elimina tag", async () => {
    const createRes = await fetch(url("/tags"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "DeleteTest" }),
    });
    const created = (await createRes.json()).tag;
    const tagId = created.id;

    const deleteRes = await fetch(url(`/tags/${tagId}`), {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(deleteRes.status, 200);
    const deleted = await deleteRes.json();
    assert.equal(deleted.deleted, true);

    const getRes = await fetch(url(`/tags/${tagId}`), {
      headers: auth(),
    });
    assert.equal(getRes.status, 404);
  });
});
