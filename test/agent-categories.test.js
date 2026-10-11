import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

describe("agent: categories CRUD", () => {
  let site, otherSite, user, server, baseUrl, rwToken, rToken;

  before(async () => {
    site = await createTestSite("Agent Categories Site");
    otherSite = await createTestSite("Agent Categories Other Site");
    user = await createTestUser(site.id, "admin");
    const rw = await createApiToken(user.id, "rw token", 30, ["read", "write"]);
    rwToken = rw.token;
    const r = await createApiToken(user.id, "r token", 30, ["read"]);
    rToken = r.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  test("CRUD categories", async () => {
    // 1. Create
    let res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories`, {
      method: "POST",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "C1", slug: "c1", description: "Desc", color: "#ffffff" }),
    });
    assert.equal(res.status, 201);
    const c1Id = (await res.json()).category.id;

    // 2. List
    res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories`, { headers: auth(rwToken) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).categories.length, 1);

    // 3. Update
    res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories/${c1Id}`, {
      method: "PUT",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "C1-updated", slug: "c1-upd" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).category.name, "C1-updated");

    // 4. Delete
    res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories/${c1Id}`, { method: "DELETE", headers: auth(rwToken) });
    assert.equal(res.status, 200);
  });

  test("IDOR: non può operare su categorie di un altro sito", async () => {
    // Crea una categoria in otherSite
    const otherCatId = (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id", [otherSite.id, "Foreign", "foreign"])).rows[0].id;
    
    // GET
    let res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories/${otherCatId}`, { headers: auth(rwToken) });
    assert.equal(res.status, 404);

    // PUT
    res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories/${otherCatId}`, {
      method: "PUT",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hacked", slug: "hacked" }),
    });
    assert.equal(res.status, 404);
  });

  test("slug duplicato → 409", async () => {
    await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories`, {
      method: "POST",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dup", slug: "dup" }),
    });
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories`, {
      method: "POST",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dup2", slug: "dup" }),
    });
    assert.equal(res.status, 409);
  });

  test("token senza scope write → 403 su POST/PUT/DELETE", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/categories`, {
      method: "POST",
      headers: { ...auth(rToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Readonly", slug: "ro" }),
    });
    assert.equal(res.status, 403);
  });
});
