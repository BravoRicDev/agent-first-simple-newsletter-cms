import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import homepageSectionsRoutes from "../src/routes/homepage-sections.js";

describe("CRUD /admin/homepage-sections + IDOR + dynamic activation", () => {
  let siteA, siteB, userA, server, baseUrl, jwtA;
  let sectionA, sectionB;

  before(async () => {
    siteA = await createTestSite("Homepage Sections Route Site A");
    siteB = await createTestSite("Homepage Sections Route Site B");
    userA = await createTestUser(siteA.id, "admin");
    const tokenVersion = (await query("SELECT token_version FROM users WHERE id = $1", [userA.id])).rows[0].token_version;
    jwtA = jwt.sign({
      sub: userA.id, email: userA.email, name: "Test User", role: userA.role,
      site_id: userA.site_id, token_version: tokenVersion,
    }, config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" });

    // L'home page viene creata prima dell'attivazione: activate fa seeding
    // automatico del contenuto corrente e sync lo converte nelle sezioni.
    await query(
      `INSERT INTO pages (site_id, url_path, title, content, layout_mode, published, managed_by)
       VALUES ($1, '/', 'Home', '<p>Homepage route test content</p>', 'wrapped', true, NULL)
       ON CONFLICT (site_id, url_path) DO NOTHING`,
      [siteA.id]
    );

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (key) => key; next(); });
    // Evita dipendenze dal layout EJS, come in categories.test.js.
    app.use((req, res, next) => { res.render = (view, locals) => res.status(res.statusCode || 200).json({ view, ...locals }); next(); });
    app.use(homepageSectionsRoutes);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  const post = (path, values = {}) => fetch(`${baseUrl}${path}`, {
    method: "POST", redirect: "manual",
    headers: { cookie: `token=${jwtA}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
  const get = (path) => fetch(`${baseUrl}${path}`, { headers: { cookie: `token=${jwtA}` } });

  test("CRUD: list, form, create, update e delete", async () => {
    let response = await get(`/admin/homepage-sections?site_id=${siteA.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sections.length, 0);

    response = await get(`/admin/homepage-sections/new?site_id=${siteA.id}`);
    assert.equal(response.status, 200);

    response = await post("/admin/homepage-sections", {
      site_id: String(siteA.id), section_type: "custom_html", title: "Hero route test",
      custom_html: "<section>Route-generated homepage section</section>", position: "0",
      articles_limit: "6", enabled: "on", enable_client_filter: "",
    });
    assert.equal(response.status, 302);
    sectionA = (await query(
      "SELECT id, site_id FROM homepage_sections WHERE site_id = $1 AND title = $2",
      [siteA.id, "Hero route test"]
    )).rows[0];
    assert.ok(sectionA);

    response = await get(`/admin/homepage-sections/${sectionA.id}/edit`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).section.title, "Hero route test");

    response = await post(`/admin/homepage-sections/${sectionA.id}`, {
      section_type: "custom_html", title: "Updated hero", custom_html: "<section>Updated section</section>",
      position: "2", articles_limit: "6", enabled: "on", enable_client_filter: "",
    });
    assert.equal(response.status, 302);
    const updated = (await query("SELECT * FROM homepage_sections WHERE id = $1", [sectionA.id])).rows[0];
    assert.equal(updated.title, "Updated hero");
    assert.equal(updated.position, 2);

    response = await post(`/admin/homepage-sections/${sectionA.id}/delete`);
    assert.equal(response.status, 302);
    assert.equal((await query("SELECT id FROM homepage_sections WHERE id = $1", [sectionA.id])).rows.length, 0);
  });

  test("IDOR: un utente non può modificare o eliminare una sezione di un altro sito", async () => {
    sectionB = (await query(
      `INSERT INTO homepage_sections (site_id, section_type, title, custom_html)
       VALUES ($1, 'custom_html', 'Foreign section', '<p>foreign</p>') RETURNING id`,
      [siteB.id]
    )).rows[0];
    let response = await get(`/admin/homepage-sections/${sectionB.id}/edit`);
    assert.ok([403, 404].includes(response.status), `atteso 403/404, ricevuto ${response.status}`);

    response = await post(`/admin/homepage-sections/${sectionB.id}`, {
      section_type: "custom_html", title: "Hacked", custom_html: "bad", position: "0",
      articles_limit: "6", enabled: "on",
    });
    assert.ok([403, 404].includes(response.status), `atteso 403/404, ricevuto ${response.status}`);
    response = await post(`/admin/homepage-sections/${sectionB.id}/delete`);
    assert.ok([403, 404].includes(response.status), `atteso 403/404, ricevuto ${response.status}`);
    const unchanged = (await query("SELECT title, site_id FROM homepage_sections WHERE id = $1", [sectionB.id])).rows[0];
    assert.equal(unchanged.title, "Foreign section");
    assert.equal(unchanged.site_id, siteB.id);
  });

  test("creazione sezione sincronizza content homepage quando la gestione dinamica è attiva", async () => {
    await post("/admin/homepage-sections/activate", { site_id: String(siteA.id) });
    const response = await post("/admin/homepage-sections", {
      section_type: "custom_html", title: "Visible on homepage", custom_html: "<div>ROUTE_SECTION_GENERATED</div>",
      position: "5", articles_limit: "6", enabled: "on",
    });
    assert.equal(response.status, 302);
    const homepage = (await query("SELECT content FROM pages WHERE site_id = $1 AND url_path = '/'", [siteA.id])).rows[0];
    assert.ok(homepage.content.includes("ROUTE_SECTION_GENERATED"));
  });

  test("activate/deactivate aggiorna flag e managed_by preservando il content congelato", async () => {
    await query("DELETE FROM homepage_sections WHERE site_id = $1", [siteA.id]);
    await query("UPDATE settings SET value = 'false' WHERE site_id = $1 AND key = 'homepage_dynamic_enabled'", [siteA.id]);
    await query("UPDATE pages SET content = '<p>Before activation</p>', managed_by = NULL WHERE site_id = $1 AND url_path = '/'", [siteA.id]);

    let response = await post("/admin/homepage-sections/activate", { site_id: String(siteA.id) });
    assert.equal(response.status, 302);
    let state = (await query(
      `SELECT s.value, p.managed_by
       FROM settings s CROSS JOIN pages p
       WHERE s.site_id = $1 AND s.key = 'homepage_dynamic_enabled'
         AND p.site_id = $1 AND p.url_path = '/'`,
      [siteA.id]
    )).rows[0];
    assert.equal(state.value, "true");
    assert.equal(state.managed_by, "homepage");

    const generated = (await query("SELECT content FROM pages WHERE site_id = $1 AND url_path = '/'", [siteA.id])).rows[0].content;
    response = await post("/admin/homepage-sections/deactivate", { site_id: String(siteA.id) });
    assert.equal(response.status, 302);
    state = (await query(
      `SELECT s.value, p.managed_by, p.content
       FROM settings s CROSS JOIN pages p
       WHERE s.site_id = $1 AND s.key = 'homepage_dynamic_enabled'
         AND p.site_id = $1 AND p.url_path = '/'`,
      [siteA.id]
    )).rows[0];
    assert.equal(state.value, "false");
    assert.equal(state.managed_by, null);
    assert.equal(state.content, generated, "deactivate congela il content generato corrente");
  });
});
