import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import { DEFAULTS } from "../src/services/blog-settings.js";

describe("agent: ergonomics (pages filtering, categorize, settings)", () => {
  let site, otherSite, user, server, baseUrl, rwToken, rToken;

  before(async () => {
    site = await createTestSite("Ergonomics Site");
    otherSite = await createTestSite("Ergonomics Other Site");
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
  const json = (token) => ({ ...auth(token), "Content-Type": "application/json" });

  test("GET /pages filtra per post_type (solo articoli)", async () => {
    await query("INSERT INTO pages (site_id, url_path, post_type) VALUES ($1, $2, 'page')", [site.id, "/normal-page"]);
    await query("INSERT INTO pages (site_id, url_path, post_type) VALUES ($1, $2, 'article')", [site.id, "/art-1"]);
    await query("INSERT INTO pages (site_id, url_path, post_type) VALUES ($1, $2, 'article')", [site.id, "/art-2"]);

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages?post_type=article`, { headers: auth(rToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.pages.length, 2);
    assert.ok(data.pages.every(p => p.url_path !== "/normal-page"));
    assert.ok(data.pages.every(p => p.post_type === "article"));
  });

  test("GET /pages filtra per category_id", async () => {
    const cat = (await query(
      "INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id",
      [site.id, "Filt Cat", "filt-cat"]
    )).rows[0];
    await query("INSERT INTO pages (site_id, url_path, post_type, category_id) VALUES ($1, $2, 'article', $3)", [site.id, "/cat-a", cat.id]);
    await query("INSERT INTO pages (site_id, url_path, post_type, category_id) VALUES ($1, $2, 'article', $3)", [site.id, "/cat-b", cat.id]);

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages?category_id=${cat.id}`, { headers: auth(rToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.pages.length, 2);
    assert.ok(data.pages.every(p => p.category_id === cat.id));
  });

  test("GET /pages/search filtra per post_type", async () => {
    await query("INSERT INTO pages (site_id, url_path, post_type, content, title) VALUES ($1, $2, 'page', $3, $4)", [site.id, "/search-page", "unicornword normal", "Unicorn Page"]);
    await query("INSERT INTO pages (site_id, url_path, post_type, content, title) VALUES ($1, $2, 'article', $3, $4)", [site.id, "/search-art", "unicornword article", "Unicorn Article"]);

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/search?q=unicornword&post_type=article`, { headers: auth(rToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].url_path, "/search-art");
  });

  test("POST /pages/bulk-categorize assegna la categoria e risincronizza", async () => {
    const p1 = (await query("INSERT INTO pages (site_id, url_path, post_type, published) VALUES ($1, $2, 'article', true) RETURNING id", [site.id, "/bulk-c1"])).rows[0].id;
    const p2 = (await query("INSERT INTO pages (site_id, url_path, post_type, published) VALUES ($1, $2, 'article', true) RETURNING id", [site.id, "/bulk-c2"])).rows[0].id;
    const cat = (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id", [site.id, "Bulk Cat", "bulk-cat"])).rows[0].id;

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/bulk-categorize`, {
      method: "POST",
      headers: json(rwToken),
      body: JSON.stringify({ page_ids: [p1, p2], category_id: cat }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.count, 2);

    const rows = (await query("SELECT category_id FROM pages WHERE id IN ($1, $2)", [p1, p2])).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.category_id === cat));

    // sync avvenuto: esiste la listing gestita dal blog
    const listing = (await query("SELECT id FROM pages WHERE site_id = $1 AND managed_by = 'blog_index'", [site.id])).rows;
    assert.ok(listing.length > 0);
  });

  test("POST /pages/bulk-categorize category_id null rimuove la categoria", async () => {
    const p = (await query("INSERT INTO pages (site_id, url_path, post_type) VALUES ($1, $2, 'page') RETURNING id", [site.id, "/bulk-null"])).rows[0].id;
    const cat = (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id", [site.id, "Null Cat", "null-cat"])).rows[0].id;
    await query("UPDATE pages SET category_id = $1 WHERE id = $2", [cat, p]);

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/bulk-categorize`, {
      method: "POST",
      headers: json(rwToken),
      body: JSON.stringify({ page_ids: [p], category_id: null }),
    });
    assert.equal(res.status, 200);
    const row = (await query("SELECT category_id FROM pages WHERE id = $1", [p])).rows[0];
    assert.equal(row.category_id, null);
  });

  test("POST /pages/bulk-publish su articoli risincronizza il blog index (fix bug)", async () => {
    const a = (await query("INSERT INTO pages (site_id, url_path, post_type, published) VALUES ($1, $2, 'article', false) RETURNING id", [site.id, "/publish-art"])).rows[0].id;

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/bulk-publish`, {
      method: "POST",
      headers: json(rwToken),
      body: JSON.stringify({ page_ids: [a], published: true }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.count, 1);

    const listing = (await query("SELECT id FROM pages WHERE site_id = $1 AND managed_by = 'blog_index'", [site.id])).rows;
    assert.ok(listing.length > 0);
  });

  test("POST /homepage-sections/reorder aggiorna le posizioni", async () => {
    const s1 = (await query("INSERT INTO homepage_sections (site_id, position, section_type, title) VALUES ($1, 1, 'custom_html', 'S1') RETURNING id", [site.id])).rows[0].id;
    const s2 = (await query("INSERT INTO homepage_sections (site_id, position, section_type, title) VALUES ($1, 2, 'custom_html', 'S2') RETURNING id", [site.id])).rows[0].id;
    const s3 = (await query("INSERT INTO homepage_sections (site_id, position, section_type, title) VALUES ($1, 3, 'custom_html', 'S3') RETURNING id", [site.id])).rows[0].id;

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/homepage-sections/reorder`, {
      method: "POST",
      headers: json(rwToken),
      body: JSON.stringify({ positions: [
        { id: s1, position: 30 },
        { id: s2, position: 10 },
        { id: s3, position: 20 },
      ] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reordered, true);
    assert.equal(data.count, 3);

    const rows = (await query("SELECT id, position FROM homepage_sections WHERE id = ANY($1::int[])", [[s1, s2, s3]])).rows;
    const byId = Object.fromEntries(rows.map(r => [r.id, r.position]));
    assert.equal(byId[s1], 30);
    assert.equal(byId[s2], 10);
    assert.equal(byId[s3], 20);
  });

  test("POST /homepage-sections/reorder id di altro sito → 400", async () => {
    const mine = (await query("INSERT INTO homepage_sections (site_id, position, section_type, title) VALUES ($1, 1, 'custom_html', 'Mine') RETURNING id", [site.id])).rows[0].id;
    const foreign = (await query("INSERT INTO homepage_sections (site_id, position, section_type, title) VALUES ($1, 1, 'custom_html', 'Foreign') RETURNING id", [otherSite.id])).rows[0].id;

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/homepage-sections/reorder`, {
      method: "POST",
      headers: json(rwToken),
      body: JSON.stringify({ positions: [
        { id: mine, position: 1 },
        { id: foreign, position: 2 },
      ] }),
    });
    assert.equal(res.status, 400);
  });

  test("GET /blog-settings ritorna i default quando non configurato", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/blog-settings`, { headers: auth(rToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.settings, DEFAULTS);
  });

  test("PUT /blog-settings salva un sottoinsieme e ignora chiavi sconosciute", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/blog-settings`, {
      method: "PUT",
      headers: json(rwToken),
      body: JSON.stringify({ blog_index_title: "Nuovo Titolo", chiave_ignota: "xxx" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).settings.blog_index_title, "Nuovo Titolo");

    const getRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/blog-settings`, { headers: auth(rToken) });
    const data = await getRes.json();
    assert.equal(data.settings.blog_index_title, "Nuovo Titolo");
    assert.equal("chiave_ignota" in data.settings, false);
  });

  test("token senza scope write → 403 sulle route di scrittura", async () => {
    const cases = [
      { url: `/api/agent/sites/${site.id}/pages/bulk-categorize`, body: { page_ids: [1], category_id: null } },
      { url: `/api/agent/sites/${site.id}/homepage-sections/reorder`, body: { positions: [{ id: 1, position: 1 }] } },
      { url: `/api/agent/sites/${site.id}/blog-settings`, body: { blog_index_title: "x" } },
    ];
    for (const c of cases) {
      const res = await fetch(`${baseUrl}${c.url}`, { method: "POST", headers: json(rToken), body: JSON.stringify(c.body) });
      assert.equal(res.status, 403, `${c.url} avrebbe dovuto essere 403`);
    }
    // PUT blog-settings read-only
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/blog-settings`, {
      method: "PUT",
      headers: json(rToken),
      body: JSON.stringify({ blog_index_title: "x" }),
    });
    assert.equal(res.status, 403);
  });
});