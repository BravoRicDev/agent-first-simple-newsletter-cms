import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain, makePage, makeCategory } from "./ext-helpers.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import feedPublicRoutes from "../src/routes/feed-public.js";

const past = () => new Date(Date.now() - 3600_000);

describe("public feed router", () => {
  let app;
  before(async () => {
    app = await startApp({ routers: [feedPublicRoutes] });
  });
  after(async () => { app.close(); await closeDb(); });

  async function newSite(enabled) {
    const site = await createTestSite("Feed Public");
    await setBlogConfig(site.id, { feed_enabled: enabled ? "1" : "0", blog_index_title: "Blog" });
    const domain = await addDomain(site.id);
    return { site, domain };
  }

  test("disabled feed -> 404 on all four URLs", async () => {
    const { domain } = await newSite(false);
    for (const p of ["/feed.xml", "/atom.xml", "/feed/news.xml", "/feed/news.atom.xml"]) {
      const r = await httpReq(app.baseUrl, p, { host: domain });
      assert.equal(r.status, 404, p);
    }
  });

  test("enabled + article -> rss 200 with ETag and Last-Modified, then 304 paths", async () => {
    const { site, domain } = await newSite(true);
    await makePage(site.id, { url_path: "/blog/a1", title: "Article 1", post_type: "article", published_at: past(), excerpt: "e1" });
    const r = await httpReq(app.baseUrl, "/feed.xml", { host: domain });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^application\/rss\+xml/);
    assert.ok(r.headers.etag, "ETag present");
    assert.ok(r.headers["last-modified"], "Last-Modified present");
    assert.match(r.text, /<title>Article 1<\/title>/);

    const byEtag = await httpReq(app.baseUrl, "/feed.xml", { host: domain, headers: { "If-None-Match": r.headers.etag } });
    assert.equal(byEtag.status, 304);
    assert.equal(byEtag.buffer.length, 0);

    const byDate = await httpReq(app.baseUrl, "/feed.xml", { host: domain, headers: { "If-Modified-Since": r.headers["last-modified"] } });
    assert.equal(byDate.status, 304);
    assert.equal(byDate.buffer.length, 0);
  });

  test("/atom.xml -> atom content-type", async () => {
    const { site, domain } = await newSite(true);
    await makePage(site.id, { url_path: "/blog/a2", title: "Article 2", post_type: "article", published_at: past() });
    const r = await httpReq(app.baseUrl, "/atom.xml", { host: domain });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^application\/atom\+xml/);
    assert.match(r.text, /<feed /);
  });

  test("/feed/<slug>.xml and /feed/<slug>.atom.xml -> 200; unknown slug -> 404", async () => {
    const { site, domain } = await newSite(true);
    const cat = await makeCategory(site.id, "News", "news");
    await makePage(site.id, { url_path: "/blog/a3", title: "Article 3", post_type: "article", published_at: past(), category_id: cat.id });
    const rss = await httpReq(app.baseUrl, "/feed/news.xml", { host: domain });
    assert.equal(rss.status, 200);
    assert.match(rss.headers["content-type"], /^application\/rss\+xml/);
    const atom = await httpReq(app.baseUrl, "/feed/news.atom.xml", { host: domain });
    assert.equal(atom.status, 200);
    assert.match(atom.headers["content-type"], /^application\/atom\+xml/);
    const nope = await httpReq(app.baseUrl, "/feed/nope.xml", { host: domain });
    assert.equal(nope.status, 404);
  });

  test("unknown Host -> 404", async () => {
    const r = await httpReq(app.baseUrl, "/feed.xml", { host: "unknown-host.invalid.test" });
    assert.equal(r.status, 404);
  });

  test("HEAD /feed.xml -> 200 with no body", async () => {
    const { site, domain } = await newSite(true);
    await makePage(site.id, { url_path: "/blog/a4", title: "Article 4", post_type: "article", published_at: past() });
    const r = await httpReq(app.baseUrl, "/feed.xml", { method: "HEAD", host: domain });
    assert.equal(r.status, 200);
    assert.equal(r.buffer.length, 0);
  });
});
