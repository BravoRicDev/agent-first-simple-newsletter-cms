import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import { isHomepageDynamicEnabled } from "../src/services/homepage-sections.js";

describe("agent: homepage articles + override + sections", () => {
  let site, user, server, baseUrl, rwToken;

  before(async () => {
    site = await createTestSite("Agent HP Site");
    user = await createTestUser(site.id, "admin");
    const rw = await createApiToken(user.id, "rw", 30, ["read", "write"]);
    rwToken = rw.token;

    await query(
      `INSERT INTO pages (site_id, url_path, title, content, layout_mode, published)
       VALUES ($1, '/', 'Home', '<p>Content</p>', 'wrapped', true)`,
      [site.id]
    );

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

  test("POST /pages con articolo e categoria → managed_by 'blog_index'", async () => {
    const cat = (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1, 'Cat', 'cat') RETURNING id", [site.id])).rows[0].id;
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages`, {
      method: "POST",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        url_path: "/test-article", title: "Article", post_type: "article", category_id: cat, published: true,
      }),
    });
    assert.equal(res.status, 201);
    // managed_by sulla riga ARTICOLO resta NULL (è contenuto scritto a mano):
    // è la pagina INDICE generata automaticamente ad avere managed_by='blog_index'.
    const listing = (await query("SELECT id FROM pages WHERE site_id = $1 AND managed_by = 'blog_index'", [site.id])).rows[0];
    assert.ok(listing, "la sincronizzazione deve aver generato la pagina indice /blog");
  });

  test("PATCH card-override", async () => {
    const page = (await query("INSERT INTO pages (site_id, url_path, title) VALUES ($1, '/test-patch', 'Patch') RETURNING id", [site.id])).rows[0];
    let res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${page.id}/card-override`, {
      method: "PATCH",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ card_html_override: "<div>OVERRIDE</div>" }),
    });
    assert.equal(res.status, 200);
    let p = (await query("SELECT card_html_override FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(p.card_html_override, "<div>OVERRIDE</div>");

    res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${page.id}/card-override`, {
      method: "PATCH",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ card_html_override: null }),
    });
    assert.equal(res.status, 200);
    p = (await query("SELECT card_html_override FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(p.card_html_override, null);
  });

  test("HP Sections CRUD + activate", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/homepage-sections`, {
      method: "POST",
      headers: { ...auth(rwToken), "Content-Type": "application/json" },
      body: JSON.stringify({ section_type: "custom_html", title: "S1", enabled: true, position: 0 }),
    });
    assert.equal(res.status, 201);
    const secId = (await res.json()).section.id;

    let active = await isHomepageDynamicEnabled(site.id);
    assert.equal(active, false);

    await fetch(`${baseUrl}/api/agent/sites/${site.id}/homepage-sections/activate`, {
      method: "POST",
      headers: auth(rwToken),
    });
    active = await isHomepageDynamicEnabled(site.id);
    assert.equal(active, true);
    
    const p = (await query("SELECT managed_by FROM pages WHERE site_id = $1 AND url_path = '/'", [site.id])).rows[0];
    assert.equal(p?.managed_by, "homepage");
  });
});
