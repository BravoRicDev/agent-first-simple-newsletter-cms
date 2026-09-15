import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

describe("Onda H — Media clone API", () => {
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
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Media Clone");
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

  // ── Media Files ────────────────────────────────────────────────────────

  test("Media: register → list with meta → get → put alt → delete", async () => {
    // Register
    const registerRes = await fetch("/files/register", {
      method: "POST",
      body: JSON.stringify({
        url: "https://example.com/image.jpg",
        filename: "image.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        alt: "Test image",
      }),
    });
    assert.equal(registerRes.status, 201);
    assert(registerRes.data.file);
    assert(registerRes.data.file.id);
    assert.equal(registerRes.data.file.filename, "image.jpg");
    assert.equal(registerRes.data.file.mimeType, "image/jpeg");
    assert.equal(registerRes.data.file.sizeBytes, 1024);
    assert.equal(registerRes.data.file.alt, "Test image");
    assert(registerRes.data.file.dateAdded);
    const fileId = registerRes.data.file.id;

    // List with meta
    const listRes = await fetch("/files");
    assert.equal(listRes.status, 200);
    assert(listRes.data.files);
    assert(Array.isArray(listRes.data.files));
    assert(listRes.data.meta);
    assert.equal(typeof listRes.data.meta.total, "number");
    assert(listRes.data.meta.total >= 1);
    assert(listRes.data.files.some((f) => f.id === fileId));

    // Get
    const getRes = await fetch(`/files/${fileId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.file.id, fileId);
    assert.equal(getRes.data.file.filename, "image.jpg");

    // Put alt
    const putRes = await fetch(`/files/${fileId}`, {
      method: "PUT",
      body: JSON.stringify({ alt: "Updated alt text" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.file.alt, "Updated alt text");

    // Delete
    const delRes = await fetch(`/files/${fileId}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);

    // Verify deleted
    const getAfterDel = await fetch(`/files/${fileId}`);
    assert.equal(getAfterDel.status, 404);
  });

  test("Media: list pagination with cursor", async () => {
    // Register 3 files
    const fileIds = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch("/files/register", {
        method: "POST",
        body: JSON.stringify({
          url: `https://example.com/file${i}.jpg`,
          filename: `file${i}.jpg`,
        }),
      });
      fileIds.push(res.data.file.id);
    }

    // List with limit 2
    const list1 = await fetch("/files?limit=2");
    assert.equal(list1.status, 200);
    assert(list1.data.files.length <= 2);
    assert.ok(list1.data.meta.total >= 3);

    // If nextPage present, fetch next
    if (list1.data.meta.nextPage) {
      const list2 = await fetch(`/files?limit=2&startAfterId=${list1.data.meta.nextPage}`);
      assert.equal(list2.status, 200);
      // Shouldn't have duplicates from page 1
      const ids1 = list1.data.files.map((f) => f.id);
      const ids2 = list2.data.files.map((f) => f.id);
      const intersection = ids1.filter((id) => ids2.includes(id));
      assert.equal(intersection.length, 0, "Pagination pages should not overlap");
    }
  });

  test("Media: register returns 400 without required fields", async () => {
    const resNoUrl = await fetch("/files/register", {
      method: "POST",
      body: JSON.stringify({ filename: "test.jpg" }),
    });
    assert.equal(resNoUrl.status, 400);

    const resNoFilename = await fetch("/files/register", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/test.jpg" }),
    });
    assert.equal(resNoFilename.status, 400);
  });

  test("Media: get invalid UUID returns 400", async () => {
    const res = await fetch("/files/invalid-uuid");
    assert.equal(res.status, 400);
    assert.equal(res.data.statusCode, 400);
  });

  test("Media: get non-existent file returns 404", async () => {
    const res = await fetch("/files/12345678-1234-1234-1234-123456789012");
    assert.equal(res.status, 404);
  });
});
