import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestSite, closeDb } from "./helpers.js";
import { makePage } from "./ext-helpers.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import { exportPublishedPages, STATIC_ROOT, getSiteStaticDir } from "../src/services/static-export.js";

// LIMITAZIONE (documentata): exportPublishedPagesInner ritorna prima di generateSeoFiles
// quando la query delle pagine ritorna 0 righe, quindi i file feed non vengono aggiornati
// da un export che non trova pagine pubblicate. Il full export periodico (ogni 5 min)
// li aggiorna; il feed live /feed.xml e' sempre esatto.

describe("feed static export integration", () => {
  let site, dir, ciao, article;

  before(async () => {
    site = await createTestSite("Feed Static Site");
    dir = getSiteStaticDir(site.id);
    ciao = await makePage(site.id, { url_path: "/ciao", title: "Ciao", content: "<p>ciao</p>", published: true, post_type: "page" });
  });

  after(async () => {
    fs.rmSync(path.join(STATIC_ROOT, String(site.id)), { recursive: true, force: true });
    await closeDb();
  });

  test("(a) feed disabled: ciao.html has no feed link and no feed.xml is written", async () => {
    await setBlogConfig(site.id, { feed_enabled: "0" });
    await exportPublishedPages({ siteId: site.id });
    const html = fs.readFileSync(path.join(dir, "ciao.html"), "utf-8");
    assert.ok(!html.includes("application/rss+xml"));
    assert.ok(!fs.existsSync(path.join(dir, "feed.xml")));
  });

  test("(b) feed enabled + article: feed.xml, atom.xml written and ciao.html gets link before </head>", async () => {
    await setBlogConfig(site.id, { feed_enabled: "1", blog_index_title: "Blog" });
    article = await makePage(site.id, {
      url_path: "/blog/articolo-feed", title: "Articolo feed", content: "<p>x</p>",
      published: true, post_type: "article", published_at: new Date(),
    });
    await exportPublishedPages({ siteId: site.id });
    assert.ok(fs.existsSync(path.join(dir, "feed.xml")));
    assert.ok(fs.existsSync(path.join(dir, "atom.xml")));
    const html = fs.readFileSync(path.join(dir, "ciao.html"), "utf-8");
    const linkIdx = html.indexOf('<link rel="alternate" type="application/rss+xml"');
    const headEnd = html.search(/<\/head>/i);
    assert.ok(linkIdx > -1, "feed link missing");
    assert.ok(linkIdx < headEnd, "feed link must be before </head>");
  });

  test("(c) feed disabled again + export: feed.xml removed", async () => {
    await setBlogConfig(site.id, { feed_enabled: "0" });
    await exportPublishedPages({ siteId: site.id });
    assert.ok(!fs.existsSync(path.join(dir, "feed.xml")));
  });

  test("(d) partial export (pageIds) also rewrites feed.xml", async () => {
    await setBlogConfig(site.id, { feed_enabled: "1", blog_index_title: "Blog" });
    fs.rmSync(path.join(dir, "feed.xml"), { force: true });
    await exportPublishedPages({ siteId: site.id, pageIds: [ciao.id] });
    assert.ok(fs.existsSync(path.join(dir, "feed.xml")), "partial export must reach generateSeoFiles and write feed.xml");
    assert.ok(article.id);
  });
});
