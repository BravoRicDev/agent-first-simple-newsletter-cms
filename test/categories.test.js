import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import categoriesRoutes from "../src/routes/categories.js";

describe("CRUD /admin/categories + IDOR + unicità slug per sito", () => {
  let siteA, siteB, userA, userB, server, baseUrl, jwtA, jwtB;
  let categoryA, categoryB;

  before(async () => {
    siteA = await createTestSite("Categories Test Site A");
    siteB = await createTestSite("Categories Test Site B");
    userA = await createTestUser(siteA.id, "admin");
    userB = await createTestUser(siteB.id, "admin");
    const signUser = async (user) => {
      const uv = (await query("SELECT token_version FROM users WHERE id = $1", [user.id])).rows[0].token_version;
      return jwt.sign({ sub: user.id, email: user.email, name: "Test User", role: user.role, site_id: user.site_id, token_version: uv }, config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" });
    };
    jwtA = await signUser(userA);
    jwtB = await signUser(userB);
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    // Stesso trick del test admin-agent-token-scopes.test.js per evitare il rendering EJS.
    app.use((req, res, next) => { res.render = (view, locals) => res.json(locals); next(); });
    app.use(categoriesRoutes);
    app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
    categoryB = (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id", [siteB.id, "Category B", "category-b"])).rows[0];
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const postForm = (token, path, values) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: `token=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
  const get = (token, path) => fetch(`${baseUrl}${path}`, { headers: { cookie: `token=${token}` } });

  test("CRUD: list, new form, create, edit, update e delete", async () => {
    let response = await get(jwtA, `/admin/categories?site_id=${siteA.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).categories, []);

    response = await get(jwtA, `/admin/categories/new?site_id=${siteB.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).site.id, siteA.id, "la query non deve cambiare il sito dell'utente");

    response = await postForm(jwtA, "/admin/categories", { name: "Guide pratiche", slug: "guide-pratiche", description: "Tutorial", site_id: String(siteB.id) });
    assert.equal(response.status, 302);
    categoryA = (await query("SELECT id, site_id FROM categories WHERE site_id = $1 AND slug = $2", [siteA.id, "guide-pratiche"])).rows[0];
    assert.ok(categoryA, "la categoria va creata sul sito dal JWT, non dal body");

    response = await get(jwtA, `/admin/categories/${categoryA.id}/edit`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).category.name, "Guide pratiche");

    response = await postForm(jwtA, `/admin/categories/${categoryA.id}/update`, { name: "Guide avanzate", slug: "guide-avanzate", description: "Tutorial aggiornati", site_id: String(siteB.id) });
    assert.equal(response.status, 302);
    const updated = (await query("SELECT * FROM categories WHERE id = $1", [categoryA.id])).rows[0];
    assert.equal(updated.name, "Guide avanzate");
    assert.equal(updated.site_id, siteA.id);

    response = await postForm(jwtA, `/admin/categories/${categoryA.id}/delete`, {});
    assert.equal(response.status, 302);
    assert.equal((await query("SELECT id FROM categories WHERE id = $1", [categoryA.id])).rows.length, 0);
  });

  test("IDOR: utente sito A non può leggere categoria sito B", async () => {
    const response = await get(jwtA, `/admin/categories/${categoryB.id}/edit`);
    assert.ok([403, 404].includes(response.status), `atteso 403/404, ricevuto ${response.status}`);
  });

  test("IDOR: utente sito A non può modificare categoria sito B", async () => {
    const response = await postForm(jwtA, `/admin/categories/${categoryB.id}/update`, { name: "Hack", slug: "hack" });
    assert.ok([403, 404].includes(response.status), `atteso 403/404, ricevuto ${response.status}`);
    const unchanged = (await query("SELECT name, slug FROM categories WHERE id = $1", [categoryB.id])).rows[0];
    assert.deepEqual(unchanged, { name: "Category B", slug: "category-b" });
  });

  test("IDOR: utente sito A non può cancellare categoria sito B", async () => {
    const response = await postForm(jwtA, `/admin/categories/${categoryB.id}/delete`, {});
    assert.ok([403, 404].includes(response.status), `atteso 403/404, ricevuto ${response.status}`);
    assert.equal((await query("SELECT id FROM categories WHERE id = $1", [categoryB.id])).rows.length, 1);
  });

  test("unicità slug: stesso slug ammesso su siti diversi", async () => {
    const response = await postForm(jwtA, "/admin/categories", { name: "Stesso slug", slug: "category-b", description: "", site_id: String(siteB.id) });
    assert.equal(response.status, 302);
    assert.equal((await query("SELECT id FROM categories WHERE site_id = $1 AND slug = $2", [siteA.id, "category-b"])).rows.length, 1);
  });

  test("unicità slug: duplicato sullo stesso sito viene rifiutato", async () => {
    const response = await postForm(jwtA, "/admin/categories", { name: "Duplicata", slug: "category-b", description: "" });
    assert.equal(response.status, 400);
  });

  test("lo slug deve rispettare [a-z0-9]+(-[a-z0-9]+)*", async () => {
    for (const slug of ["Upper", "due--trattini", "-inizio", "fine-", "con_underscore", "spazio non-valido"]) {
      const response = await postForm(jwtA, "/admin/categories", { name: "Invalid", slug });
      assert.equal(response.status, 400, `slug ${slug} deve essere rifiutato`);
    }
  });
});