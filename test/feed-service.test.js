import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { makePage, makeCategory } from "./ext-helpers.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import {
  xmlText, cdata, absolutizeHtml, feedPath, renderFeed, getFeedItems,
  makeFeedLinkResolver, injectFeedLinks, writeFeedFiles,
} from "../src/services/feed.js";

const BASE = "https://e.test";
const past = () => new Date(Date.now() - 3600_000);
const future = () => new Date(Date.now() + 3600_000 * 24);

async function newSite(cfg = {}) {
  const site = await createTestSite("Feed Site");
  await setBlogConfig(site.id, { feed_enabled: "1", blog_index_title: "Blog", ...cfg });
  return site;
}

describe("feed service", () => {
  after(async () => { await closeDb(); });

  test("(1) xmlText escapes and strips invalid control chars", () => {
    assert.equal(xmlText('<a&"b">'), "&lt;a&amp;&quot;b&quot;&gt;");
    assert.equal(xmlText("x\u0001y\u000Bz"), "xyz");
  });

  test("(2) cdata escapes ]]> and round-trips", () => {
    assert.equal(cdata("a]]>b"), "<![CDATA[a]]]]><![CDATA[>b]]>");
    const $ = cheerio.load(`<r>${cdata("a]]>b")}</r>`, { xmlMode: true });
    assert.equal($("r").text(), "a]]>b");
  });

  test("(3) absolutizeHtml makes /x absolute and leaves //host untouched", () => {
    assert.equal(absolutizeHtml('<a href="/x">', "https://e.test/"), '<a href="https://e.test/x">');
    assert.equal(absolutizeHtml('<img src="//cdn.test/a.png">', BASE), '<img src="//cdn.test/a.png">');
    assert.equal(feedPath("rss"), "/feed.xml");
    assert.equal(feedPath("atom", "news"), "/feed/news.atom.xml");
  });

  test("(4) feed disabled -> renderFeed returns null", async () => {
    const site = await createTestSite("Disabled");
    await setBlogConfig(site.id, { feed_enabled: "0" });
    assert.equal(await renderFeed(site.id, { format: "rss", baseUrl: BASE }), null);
  });

  test("(5) only eligible articles are listed", async () => {
    const site = await newSite();
    const ok = await makePage(site.id, { title: "OK-ARTICLE", post_type: "article", published: true, published_at: past() });
    await makePage(site.id, { title: "EX-UNPUB", post_type: "article", published: false, published_at: past() });
    await makePage(site.id, { title: "EX-FUTURE", post_type: "article", published: true, published_at: future() });
    await makePage(site.id, { title: "EX-EXPIRED", post_type: "article", published: true, published_at: past(), extra: { unpublish_at: past() } });
    const noindex = await makePage(site.id, { title: "EX-NOINDEX", post_type: "article", published: true, published_at: past() });
    await query("INSERT INTO page_seo (page_id, noindex) VALUES ($1, true)", [noindex.id]);
    await makePage(site.id, { title: "EX-PAGE", post_type: "page", published: true, published_at: past() });
    await makePage(site.id, { title: "EX-NULLDATE", post_type: "article", published: true, published_at: null });
    const items = await getFeedItems(site.id, { limit: 50 });
    const titles = items.map((i) => i.title);
    assert.ok(titles.includes("OK-ARTICLE"));
    for (const t of ["EX-UNPUB", "EX-FUTURE", "EX-EXPIRED", "EX-NOINDEX", "EX-PAGE", "EX-NULLDATE"]) {
      assert.ok(!titles.includes(t), t + " must be excluded");
    }
    assert.equal(ok.post_type, "article");
  });

  test("(6) feed_item_limit caps items, newest first", async () => {
    const site = await newSite({ feed_item_limit: "2" });
    const base = Date.now() - 10 * 3600_000;
    await makePage(site.id, { title: "L-1", post_type: "article", published: true, published_at: new Date(base + 1000) });
    await makePage(site.id, { title: "L-2", post_type: "article", published: true, published_at: new Date(base + 2000) });
    await makePage(site.id, { title: "L-3", post_type: "article", published: true, published_at: new Date(base + 3000) });
    const r = await renderFeed(site.id, { format: "rss", baseUrl: BASE });
    assert.equal(r.count, 2);
    const $ = cheerio.load(r.body, { xmlMode: true });
    const titles = $("item > title").map((_, el) => $(el).text()).get();
    assert.deepEqual(titles, ["L-3", "L-2"]);
  });

  test("(7) category feed filters by slug; unknown or invalid slug -> null", async () => {
    const site = await newSite();
    const cat = await makeCategory(site.id, "News", "news");
    const other = await makeCategory(site.id, "Other", "other");
    await makePage(site.id, { title: "IN-CAT", post_type: "article", published: true, published_at: past(), category_id: cat.id });
    await makePage(site.id, { title: "OUT-CAT", post_type: "article", published: true, published_at: past(), category_id: other.id });
    const r = await renderFeed(site.id, { format: "rss", categorySlug: "news", baseUrl: BASE });
    assert.equal(r.count, 1);
    assert.ok(r.body.includes("IN-CAT") && !r.body.includes("OUT-CAT"));
    assert.equal(await renderFeed(site.id, { format: "rss", categorySlug: "nope", baseUrl: BASE }), null);
    assert.equal(await renderFeed(site.id, { format: "rss", categorySlug: "../x", baseUrl: BASE }), null);
  });

  test("(8) RSS: guid, pubDate GMT, CDATA description, content:encoded when full", async () => {
    const site = await newSite({ feed_full_content: "1" });
    await makePage(site.id, { title: "RSS-ITEM", post_type: "article", published: true, published_at: past(), content: '<p><img src="/img/a.png"></p>', excerpt: "exc", extra: { featured_image: "/img/a.png" } });
    const r = await renderFeed(site.id, { format: "rss", baseUrl: BASE });
    assert.match(r.body, /<guid isPermaLink="true">https:\/\/e\.test\//);
    assert.match(r.body, /<pubDate>[^<]*GMT<\/pubDate>/);
    assert.match(r.body, /<description><!\[CDATA\[exc\]\]><\/description>/);
    assert.ok(r.body.includes('<content:encoded><![CDATA[<p><img src="https://e.test/img/a.png"></p>]]></content:encoded>'));
    const $ = cheerio.load(r.body, { xmlMode: true });
    assert.equal($("rss").length, 1);
  });

  test("(9) Atom: one entry per item with ISO updated", async () => {
    const site = await newSite();
    await makePage(site.id, { title: "ATOM-ITEM", post_type: "article", published: true, published_at: past() });
    const r = await renderFeed(site.id, { format: "atom", baseUrl: BASE });
    const $ = cheerio.load(r.body, { xmlMode: true });
    assert.equal($("entry").length, 1);
    assert.match($("entry > updated").first().text(), /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test("(10) etag stable without changes, changes after UPDATE", async () => {
    const site = await newSite();
    const p = await makePage(site.id, { title: "ETAG-1", post_type: "article", published: true, published_at: past() });
    const a = await renderFeed(site.id, { format: "rss", baseUrl: BASE });
    const b = await renderFeed(site.id, { format: "rss", baseUrl: BASE });
    assert.equal(a.etag, b.etag);
    await query("UPDATE pages SET title = $1 WHERE id = $2", ["ETAG-2", p.id]);
    const c = await renderFeed(site.id, { format: "rss", baseUrl: BASE });
    assert.notEqual(a.etag, c.etag);
  });

  test("(11) link resolver and injectFeedLinks", async () => {
    const site = await newSite();
    const cat = await makeCategory(site.id, "Tech", "tech");
    await makePage(site.id, { title: "LNK", post_type: "article", published: true, published_at: past(), category_id: cat.id });
    const resolve = await makeFeedLinkResolver(site.id);
    const home = resolve("/");
    assert.equal(home.split("\n").length, 2);
    const catTags = resolve("/blog/categoria/tech/pagina/2");
    assert.equal(catTags.split("\n").length, 4);
    assert.ok(catTags.includes('href="/feed/tech.xml"'));
    const off = await createTestSite("LinksOff");
    await setBlogConfig(off.id, { feed_enabled: "0" });
    assert.equal((await makeFeedLinkResolver(off.id))("/"), "");
    assert.equal(injectFeedLinks("<html><HEAD></HEAD>", "<x>"), "<html><HEAD><x>\n</HEAD>");
    assert.equal(injectFeedLinks("<html><head></head>", ""), "<html><head></head>");
    assert.equal(injectFeedLinks("<html></body>", "<x>"), "<html></body>");
  });

  test("(12) writeFeedFiles writes files and removes them when disabled", async () => {
    const site = await newSite();
    const cat = await makeCategory(site.id, "Dir", "dir");
    await makePage(site.id, { title: "WRITE", post_type: "article", published: true, published_at: past(), category_id: cat.id });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
    await writeFeedFiles(site.id, BASE, dir);
    for (const f of ["feed.xml", "atom.xml", "feed/dir.xml", "feed/dir.atom.xml"]) {
      assert.ok(fs.existsSync(path.join(dir, f)), f + " must exist");
    }
    await setBlogConfig(site.id, { feed_enabled: "0" });
    await writeFeedFiles(site.id, BASE, dir);
    for (const f of ["feed.xml", "atom.xml", "feed/dir.xml", "feed/dir.atom.xml"]) {
      assert.ok(!fs.existsSync(path.join(dir, f)), f + " must be removed");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("(13) privacy: staff names never appear in feeds", async () => {
    const site = await newSite({ feed_full_content: "1" });
    const user = await createTestUser(site.id, "admin");
    await query("UPDATE users SET name = $1 WHERE id = $2", ["Secret Staff Name", user.id]);
    await makePage(site.id, { title: "PRIV", post_type: "article", published: true, published_at: past(), extra: { author_id: user.id } });
    const rss = await renderFeed(site.id, { format: "rss", baseUrl: BASE });
    const atom = await renderFeed(site.id, { format: "atom", baseUrl: BASE });
    assert.ok(!rss.body.includes("Secret Staff Name"));
    assert.ok(!atom.body.includes("Secret Staff Name"));
  });

  test("(14) hand-made feed.xml without marker survives writeFeedFiles", async () => {
    const site = await newSite();
    await setBlogConfig(site.id, { feed_enabled: "0" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-manual-"));
    const manual = path.join(dir, "feed.xml");
    fs.writeFileSync(manual, "<rss>manual</rss>");
    await writeFeedFiles(site.id, BASE, dir);
    assert.equal(fs.readFileSync(manual, "utf-8"), "<rss>manual</rss>");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
