import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import pagesRoutes from "../src/routes/pages.js";

describe("Campi articolo editor pagine", () => {
  let siteA, siteB, userA, server, baseUrl, token, categoryA, categoryB;
  const pageIds = [];

  before(async () => {
    siteA = await createTestSite("Article Fields Site A");
    siteB = await createTestSite("Article Fields Site B");
    userA = await createTestUser(siteA.id, "admin");
    categoryA = (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id", [siteA.id, "News", `news-${siteA.id}`])).rows[0];
    categoryB = (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id", [siteB.id, "Foreign", `foreign-${siteB.id}`])).rows[0];
    const tokenVersion = (await query("SELECT token_version FROM users WHERE id = $1", [userA.id])).rows[0].token_version;
    token = jwt.sign({ sub: userA.id, email: userA.email, name: "Test User", role: userA.role, site_id: userA.site_id, token_version: tokenVersion }, config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" });
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (key) => key; next(); });
    app.use((req, res, next) => { res.render = (view, locals) => res.status(res.statusCode || 200).json({ view, ...locals }); next(); });
    app.use(pagesRoutes);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  const post = (path, values) => fetch(`${baseUrl}${path}`, {
    method: "POST", redirect: "manual",
    headers: { cookie: `token=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });

  test("creazione e aggiornamento persistono i campi articolo", async () => {
    let response = await post("/admin/pages", {
      site_id: String(siteA.id), url_path: "/article-fields", title: "Prima", content: "Corpo",
      post_type: "article", category_id: String(categoryA.id), excerpt: "Estratto", featured_image: "/media/cover.jpg",
      published_at: "2024-01-02T03:04:05.000Z", author_id: "0",
    });
    assert.equal(response.status, 302);
    let page = (await query("SELECT * FROM pages WHERE site_id = $1 AND url_path = $2", [siteA.id, "/article-fields"])).rows[0];
    pageIds.push(page.id);
    assert.equal(page.post_type, "article");
    assert.equal(page.category_id, categoryA.id);
    assert.equal(page.excerpt, "Estratto");
    assert.equal(page.featured_image, "/media/cover.jpg");
    assert.equal(new Date(page.published_at).toISOString(), "2024-01-02T03:04:05.000Z");

    response = await post(`/admin/pages/${page.id}`, {
      url_path: "/article-fields", title: "Dopo", content: "Corpo aggiornato", layout_mode: "wrapped", published: "false",
      post_type: "article", category_id: String(categoryA.id), excerpt: "Nuovo excerpt", featured_image: "https://example.test/new.jpg",
      published_at: "2024-02-03T04:05:06.000Z", author_id: "",
    });
    assert.equal(response.status, 302);
    page = (await query("SELECT * FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(page.title, "Dopo");
    assert.equal(page.category_id, categoryA.id);
    assert.equal(page.excerpt, "Nuovo excerpt");
    assert.equal(page.featured_image, "https://example.test/new.jpg");
    assert.equal(new Date(page.published_at).toISOString(), "2024-02-03T04:05:06.000Z");
  });

  test("restore versione ripristina category_id, excerpt e featured_image", async () => {
    const pageId = pageIds[0];
    await post(`/admin/pages/${pageId}`, {
      url_path: "/article-fields", title: "Terza", content: "Terzo corpo", post_type: "article", published: "false",
      category_id: "", excerpt: "Vuoto", featured_image: "",
    });
    const prior = (await query("SELECT id FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [pageId])).rows[0];
    assert.ok(prior, "l'update deve aver creato la snapshot precedente");
    const response = await post(`/admin/pages/${pageId}/versions/${prior.id}/restore`, {});
    assert.equal(response.status, 302);
    const restored = (await query("SELECT category_id, excerpt, featured_image FROM pages WHERE id = $1", [pageId])).rows[0];
    assert.equal(restored.category_id, categoryA.id);
    assert.equal(restored.excerpt, "Nuovo excerpt");
    assert.equal(restored.featured_image, "https://example.test/new.jpg");
  });

  test("pubblicare articolo senza published_at assegna automaticamente un timestamp recente", async () => {
    const beforeAt = Date.now();
    const response = await post("/admin/pages", {
      site_id: String(siteA.id), url_path: "/article-auto-date", title: "Data automatica", post_type: "article", published: "true",
    });
    assert.equal(response.status, 302);
    const page = (await query("SELECT published_at FROM pages WHERE site_id = $1 AND url_path = $2", [siteA.id, "/article-auto-date"])).rows[0];
    pageIds.push((await query("SELECT id FROM pages WHERE site_id = $1 AND url_path = $2", [siteA.id, "/article-auto-date"])).rows[0].id);
    const publishedAt = new Date(page.published_at).getTime();
    assert.ok(publishedAt >= beforeAt - 1000 && publishedAt <= Date.now() + 1000);
  });

  test("published_at esplicito non viene sovrascritto alla pubblicazione", async () => {
    const exact = "2020-05-06T07:08:09.000Z";
    const response = await post("/admin/pages", {
      site_id: String(siteA.id), url_path: "/article-explicit-date", title: "Data esplicita", post_type: "article", published: "true", published_at: exact,
    });
    assert.equal(response.status, 302);
    const page = (await query("SELECT id, published_at FROM pages WHERE site_id = $1 AND url_path = $2", [siteA.id, "/article-explicit-date"])).rows[0];
    pageIds.push(page.id);
    assert.equal(new Date(page.published_at).toISOString(), exact);
  });

  test("creazione articolo sincronizza la pagina listing gestita", async () => {
    const listingSite = await createTestSite("Blog Listing Create Site");
    const listingCategory = (await query(
      "INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id",
      [listingSite.id, "Blog News", `blog-news-${listingSite.id}`]
    )).rows[0];
    const listingUser = await createTestUser(listingSite.id, "admin");
    const listingTokenVersion = (await query("SELECT token_version FROM users WHERE id = $1", [listingUser.id])).rows[0].token_version;
    const listingToken = jwt.sign({ sub: listingUser.id, email: listingUser.email, name: "Test User", role: listingUser.role, site_id: listingUser.site_id, token_version: listingTokenVersion }, config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" });
    const response = await fetch(`${baseUrl}/admin/pages`, {
      method: "POST", redirect: "manual",
      headers: { cookie: `token=${listingToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url_path: "/blog-create-article", title: "Listing test article", post_type: "article", category_id: String(listingCategory.id), published: "true" }),
    });
    assert.equal(response.status, 302);
    const listing = (await query(
      "SELECT id FROM pages WHERE site_id = $1 AND managed_by = 'blog_index'",
      [listingSite.id]
    )).rows[0];
    assert.ok(listing, "la creazione dell'articolo deve creare la pagina /blog gestita");
    pageIds.push(listing.id);
    pageIds.push((await query("SELECT id FROM pages WHERE site_id = $1 AND url_path = $2", [listingSite.id, "/blog-create-article"])).rows[0].id);
  });

  test("cancellare l'unico articolo rimuove la pagina listing gestita", async () => {
    const listingSite = await createTestSite("Blog Listing Delete Site");
    const listingCategory = (await query(
      "INSERT INTO categories (site_id, name, slug) VALUES ($1, $2, $3) RETURNING id",
      [listingSite.id, "Blog Delete", `blog-delete-${listingSite.id}`]
    )).rows[0];
    const listingUser = await createTestUser(listingSite.id, "admin");
    const listingTokenVersion = (await query("SELECT token_version FROM users WHERE id = $1", [listingUser.id])).rows[0].token_version;
    const listingToken = jwt.sign({ sub: listingUser.id, email: listingUser.email, name: "Test User", role: listingUser.role, site_id: listingUser.site_id, token_version: listingTokenVersion }, config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" });
    const createResponse = await fetch(`${baseUrl}/admin/pages`, {
      method: "POST", redirect: "manual",
      headers: { cookie: `token=${listingToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url_path: "/blog-delete-article", title: "Article to delete", post_type: "article", category_id: String(listingCategory.id), published: "true" }),
    });
    assert.equal(createResponse.status, 302);
    const article = (await query("SELECT id FROM pages WHERE site_id = $1 AND url_path = $2", [listingSite.id, "/blog-delete-article"])).rows[0];
    const deleteResponse = await fetch(`${baseUrl}/admin/pages/${article.id}/delete`, {
      method: "POST", redirect: "manual", headers: { cookie: `token=${listingToken}` },
    });
    assert.equal(deleteResponse.status, 302);
    const listing = await query("SELECT id FROM pages WHERE site_id = $1 AND managed_by = 'blog_index'", [listingSite.id]);
    assert.equal(listing.rows.length, 0);
  });

  test("IDOR: rifiuta category_id appartenente a un altro sito", async () => {
    const response = await post("/admin/pages", {
      site_id: String(siteA.id), url_path: "/article-foreign-category", title: "IDOR", post_type: "article", category_id: String(categoryB.id),
    });
    assert.equal(response.status, 400);
    assert.equal((await query("SELECT id FROM pages WHERE site_id = $1 AND url_path = $2", [siteA.id, "/article-foreign-category"])).rows.length, 0);
  });

  test("IDOR: rifiuta author_id appartenente a un altro sito", async () => {
    // Crea un utente nel sito B
    const userB = await createTestUser(siteB.id, "admin");
    const response = await post("/admin/pages", {
      site_id: String(siteA.id), url_path: "/article-foreign-author", title: "IDOR author", post_type: "article", author_id: String(userB.id),
    });
    assert.equal(response.status, 400);
    assert.equal((await query("SELECT id FROM pages WHERE site_id = $1 AND url_path = $2", [siteA.id, "/article-foreign-author"])).rows.length, 0);
  });

  test("category_id vuoto o zero viene salvato come NULL", async () => {
    for (const [index, value] of ["", "0"].entries()) {
      const url = `/article-null-category-${index}`;
      const response = await post("/admin/pages", { site_id: String(siteA.id), url_path: url, title: "Senza categoria", post_type: "article", category_id: value });
      assert.equal(response.status, 302);
      const page = (await query("SELECT id, category_id FROM pages WHERE site_id = $1 AND url_path = $2", [siteA.id, url])).rows[0];
      pageIds.push(page.id);
      assert.equal(page.category_id, null);
    }
  });

  test("card_title/reading_time_minutes/card_html_override: creati, letti e preservati su un update successivo", async () => {
    const url = "/article-card-override-roundtrip";
    let response = await post("/admin/pages", {
      site_id: String(siteA.id), url_path: url, title: "Titolo SEO lungo", post_type: "article",
      card_title: "Titolo breve", reading_time_minutes: "4", card_html_override: "<article>CONGELATO</article>",
    });
    assert.equal(response.status, 302);
    let page = (await query(
      "SELECT id, card_title, reading_time_minutes, card_html_override FROM pages WHERE site_id = $1 AND url_path = $2",
      [siteA.id, url]
    )).rows[0];
    pageIds.push(page.id);
    assert.equal(page.card_title, "Titolo breve");
    assert.equal(page.reading_time_minutes, 4);
    assert.equal(page.card_html_override, "<article>CONGELATO</article>");

    // Un admin che ri-salva la pagina dall'editor (che precompila questi campi
    // con i valori attuali) NON deve farli sparire: simula l'update inviando
    // di nuovo esattamente i valori che l'editor avrebbe precompilato.
    response = await post(`/admin/pages/${page.id}`, {
      url_path: url, title: "Titolo SEO lungo modificato", post_type: "article",
      card_title: "Titolo breve", reading_time_minutes: "4", card_html_override: "<article>CONGELATO</article>",
    });
    assert.equal(response.status, 302);
    page = (await query(
      "SELECT card_title, reading_time_minutes, card_html_override FROM pages WHERE id = $1",
      [page.id]
    )).rows[0];
    assert.equal(page.card_title, "Titolo breve", "card_title non deve sparire su un update che lo ripropone");
    assert.equal(page.reading_time_minutes, 4);
    assert.equal(page.card_html_override, "<article>CONGELATO</article>");
  });
});
