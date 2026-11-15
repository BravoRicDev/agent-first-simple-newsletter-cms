import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain, makePage, makeCategory } from "./ext-helpers.js";
import { publicCatchAllRouter } from "../src/routes/serve.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import { clearFeedLinkCache } from "../src/services/feed.js";

const HTML = "<html><head></head><body>x</body></html>";
const past = () => new Date(Date.now() - 3600_000);

describe("feed autodiscovery on live public pages", () => {
  let site, app, domain;

  before(async () => {
    site = await createTestSite("Autodiscovery Site");
    await createTestUser(site.id, "admin");
    domain = await addDomain(site.id);
    app = await startApp({ routers: [publicCatchAllRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  test("feed disabled -> no feed <link> injected", async () => {
    await setBlogConfig(site.id, { feed_enabled: "0" });
    clearFeedLinkCache();
    await makePage(site.id, { url_path: "/home-x", content: HTML, extra: { layout_mode: "standalone" } });
    const r = await httpReq(app.baseUrl, "/home-x", { host: domain });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes("<body>x</body>"));
    assert.ok(!r.text.includes("rss+xml"));
  });

  test("feed enabled -> RSS and Atom links injected before </head>", async () => {
    await setBlogConfig(site.id, { feed_enabled: "1", blog_index_title: "Blog" });
    clearFeedLinkCache();
    const r = await httpReq(app.baseUrl, "/home-x", { host: domain });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<link rel="alternate" type="application/rss+xml"'));
    assert.ok(r.text.includes("atom+xml"));
    assert.ok(r.text.includes('href="/feed.xml"'));
    assert.ok(r.text.indexOf('rss+xml') < r.text.toLowerCase().indexOf("</head>"));
  });

  test("category page -> category feed link injected", async () => {
    const cat = await makeCategory(site.id, "Notizie", "notizie-live");
    await makePage(site.id, { title: "Articolo", post_type: "article", published: true, published_at: past(), category_id: cat.id });
    clearFeedLinkCache();
    await makePage(site.id, { url_path: "/blog/categoria/notizie-live", content: HTML, extra: { layout_mode: "standalone" } });
    const r = await httpReq(app.baseUrl, "/blog/categoria/notizie-live", { host: domain });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes("/feed/notizie-live.xml"));
  });
});
