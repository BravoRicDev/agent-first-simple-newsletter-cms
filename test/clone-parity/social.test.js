import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda H: Social clone API — accounts, posts.
describe("Onda H — Social clone", () => {
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
    if (!res.ok) {
      const btxt = await res.clone().text().catch(() => "");
      console.error("DBG FAIL:", res.status, url, "BODY:", btxt.slice(0, 160));
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Social Clone");
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

  // ── Social Accounts ──────────────────────────────────────────────────

  test("Social accounts: create → list → delete", async () => {
    // Create account
    const createRes = await fetch("/social/accounts", {
      method: "POST",
      body: JSON.stringify({ platform: "facebook", accountName: "My FB Page" }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.account);
    assert(createRes.data.account.id);
    assert.equal(createRes.data.account.platform, "facebook");
    assert.equal(createRes.data.account.accountName, "My FB Page");
    assert.equal(createRes.data.account.status, "disconnected");
    assert(createRes.data.account.dateAdded);
    const accountId = createRes.data.account.id;

    // List accounts
    const listRes = await fetch("/social/accounts");
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.accounts));
    assert(listRes.data.meta);
    assert.equal(listRes.data.meta.total, 1);
    const found = listRes.data.accounts.find((a) => a.id === accountId);
    assert(found);

    // Delete account
    const delRes = await fetch(`/social/accounts/${accountId}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);

    // Verify deletion
    const listAfterRes = await fetch("/social/accounts");
    assert.equal(listAfterRes.data.meta.total, 0);
  });

  // ── Social Posts ──────────────────────────────────────────────────────

  test("Social posts: create scheduled → list → update message → delete", async () => {
    // Create scheduled post (future date)
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    const createRes = await fetch("/social/posts", {
      method: "POST",
      body: JSON.stringify({
        platform: "linkedin",
        message: "Scheduled post",
        scheduledAt: futureDate,
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.post);
    assert(createRes.data.post.id);
    assert.equal(createRes.data.post.status, "scheduled");
    assert.equal(createRes.data.post.platform, "linkedin");
    assert.equal(createRes.data.post.message, "Scheduled post");
    assert(createRes.data.post.postedAt === null);
    const postId = createRes.data.post.id;

    // List posts with platform filter
    const listRes = await fetch("/social/posts?platform=linkedin");
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.posts));
    assert(listRes.data.meta.total >= 1);
    const found = listRes.data.posts.find((p) => p.id === postId);
    assert(found);
    assert.equal(found.status, "scheduled");

    // Update post message
    const updateRes = await fetch(`/social/posts/${postId}`, {
      method: "PUT",
      body: JSON.stringify({ message: "Updated message" }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.post.message, "Updated message");

    // Delete post
    const delRes = await fetch(`/social/posts/${postId}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);
  });

  test("Social posts: create immediate (no scheduledAt) → posts immediately", async () => {
    // Create post without scheduledAt → simulated immediate post
    const createRes = await fetch("/social/posts", {
      method: "POST",
      body: JSON.stringify({
        platform: "twitter",
        message: "Immediate post",
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.post.status, "posted");
    assert(createRes.data.post.postedAt);
  });

  test("Social posts: cannot update/delete posted post", async () => {
    // Create and immediately post
    const createRes = await fetch("/social/posts", {
      method: "POST",
      body: JSON.stringify({
        platform: "facebook",
        message: "This will be posted",
      }),
    });
    const postId = createRes.data.post.id;

    // Try to update
    const updateRes = await fetch(`/social/posts/${postId}`, {
      method: "PUT",
      body: JSON.stringify({ message: "New message" }),
    });
    assert.equal(updateRes.status, 409);

    // Try to delete
    const delRes = await fetch(`/social/posts/${postId}`, { method: "DELETE" });
    assert.equal(delRes.status, 409);
  });

  test("Social posts: filter by status", async () => {
    // Create posted
    const postedRes = await fetch("/social/posts", {
      method: "POST",
      body: JSON.stringify({ platform: "instagram", message: "Posted" }),
    });

    // Create scheduled
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    const scheduledRes = await fetch("/social/posts", {
      method: "POST",
      body: JSON.stringify({
        platform: "instagram",
        message: "Scheduled",
        scheduledAt: futureDate,
      }),
    });

    // Filter by scheduled
    const listRes = await fetch("/social/posts?status=scheduled");
    assert.equal(listRes.status, 200);
    assert(listRes.data.posts.some((p) => p.id === scheduledRes.data.post.id));
  });
});
