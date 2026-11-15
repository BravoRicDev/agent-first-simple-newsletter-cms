import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { makePage } from "./ext-helpers.js";
import { query } from "../src/db.js";
import { searchPages, reindexSite } from "../src/services/search.js";
import { setBlogConfig } from "../src/services/blog-settings.js";

describe("search service", () => {
  let site, other;

  before(async () => {
    site = await createTestSite("Search");
    other = await createTestSite("Search other");
  });

  after(async () => { await closeDb(); });

  test("(1) italian stemming: 'gatto' finds 'I gatti dormono'", async () => {
    const p = await makePage(site.id, { title: "I gatti dormono", content: "<p>Pisolino pomeridiano</p>" });
    const r = await searchPages(site.id, "gatto");
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].id, p.id);
  });

  test("(2) title hit outranks body-only hit", async () => {
    const body = await makePage(site.id, { title: "Altro titolo", content: "<p>zucchero zucchero</p>" });
    const title = await makePage(site.id, { title: "Zucchero", content: "<p>niente</p>" });
    const r = await searchPages(site.id, "zucchero");
    const ids = r.results.map((x) => x.id);
    assert.ok(ids.indexOf(title.id) < ids.indexOf(body.id));
  });

  test("(3) exclusions: unpublished, expired, noindex, managed_by, other site", async () => {
    const term = "esclusione";
    const unpub = await makePage(site.id, { title: term, content: "<p>x</p>", published: false });
    const expired = await makePage(site.id, { title: term, content: "<p>x</p>", extra: { unpublish_at: new Date(Date.now() - 60000) } });
    const noidx = await makePage(site.id, { title: term, content: "<p>x</p>" });
    await query("INSERT INTO page_seo (page_id, noindex) VALUES ($1, true)", [noidx.id]);
    const managed = await makePage(site.id, { title: term, content: "<p>x</p>", extra: { managed_by: "blog_index" } });
    const foreign = await makePage(other.id, { title: term, content: "<p>x</p>" });
    const pub = await makePage(site.id, { title: term, content: "<p>x</p>" });

    const pubRes = await searchPages(site.id, term);
    const pubIds = pubRes.results.map((x) => x.id);
    assert.deepEqual(pubIds, [pub.id]);
    assert.ok(!pubIds.includes(foreign.id));

    const adm = await searchPages(site.id, term, { includeUnpublished: true });
    const admIds = adm.results.map((x) => x.id);
    assert.ok(admIds.includes(unpub.id));
    assert.ok(admIds.includes(expired.id));
    assert.ok(admIds.includes(noidx.id));
    assert.ok(!admIds.includes(managed.id));
    assert.ok(!admIds.includes(foreign.id));
    const u = adm.results.find((x) => x.id === unpub.id);
    assert.equal(u.published, false);
  });

  test("(4) script content is not indexed and snippets are escaped", async () => {
    const p = await makePage(site.id, { title: "Script test", content: "<p>cavallo <script>secretjs()</script></p>" });
    assert.equal((await searchPages(site.id, "secretjs")).results.length, 0);
    const r = await searchPages(site.id, "cavallo");
    const hit = r.results.find((x) => x.id === p.id);
    assert.ok(hit);
    assert.ok(hit.snippet.includes("<mark>cavallo</mark>"));
    assert.ok(!hit.snippet.includes("<script"));
    assert.ok(!hit.snippet.includes("secretjs"));

    const p2 = await makePage(site.id, { title: "Middle test", content: "<p>a <script>one()</script> MIDDLE <script>two()</script> zebra</p>" });
    const r2 = await searchPages(site.id, "middle");
    assert.ok(r2.results.some((x) => x.id === p2.id));
  });

  test("(5) literal entity text does not leak raw tags into snippet", async () => {
    const p = await makePage(site.id, { title: "Entity test", content: "<p>x &lt;img onerror=1&gt; foo</p>" });
    const r = await searchPages(site.id, "onerror");
    const hit = r.results.find((x) => x.id === p.id);
    assert.ok(hit);
    assert.ok(!hit.snippet.includes("<img"));
  });

  test("(6) too-short and stopword-only queries return empty without error", async () => {
    assert.deepEqual(await searchPages(site.id, "a"), { results: [], total: 0, limit: 10, offset: 0 });
    const r = await searchPages(site.id, "il lo la");
    assert.equal(r.results.length, 0);
    assert.equal(r.total, 0);
  });

  test("(7) language switch + reindexSite", async () => {
    await makePage(site.id, { title: "Running fast", content: "<p>runner</p>" });
    await setBlogConfig(site.id, { search_language: "english" });
    await reindexSite(site.id);
    const r = await searchPages(site.id, "run");
    assert.ok(r.results.some((x) => x.title === "Running fast"));
    await setBlogConfig(site.id, { search_language: "italian" });
    await reindexSite(site.id);
  });

  test("(8) total is full count while limit caps rows", async () => {
    const s = await createTestSite("Limit");
    for (let i = 0; i < 3; i++) await makePage(s.id, { title: `Limitword ${i}`, content: "<p>limitword</p>" });
    const r = await searchPages(s.id, "limitword", { limit: 1 });
    assert.equal(r.results.length, 1);
    assert.equal(r.total, 3);
  });

  test("(9) offset beyond total returns empty", async () => {
    const r = await searchPages(site.id, "gatto", { offset: 500 });
    assert.equal(r.results.length, 0);
  });

  test("(10) trigger on INSERT/UPDATE and cascade on DELETE", async () => {
    const p = await makePage(site.id, { title: "Trigger", content: "<p>oldword</p>" });
    assert.equal((await searchPages(site.id, "oldword")).results.some((x) => x.id === p.id), true);
    await query("UPDATE pages SET content = $1 WHERE id = $2", ["<p>newword</p>", p.id]);
    assert.equal((await searchPages(site.id, "oldword")).results.some((x) => x.id === p.id), false);
    assert.equal((await searchPages(site.id, "newword")).results.some((x) => x.id === p.id), true);
    await query("DELETE FROM pages WHERE id = $1", [p.id]);
    const idx = await query("SELECT 1 FROM page_search_index WHERE page_id = $1", [p.id]);
    assert.equal(idx.rows.length, 0);
  });

  test("(11) pathological script-heavy content saves in under 3 s", async () => {
    const content = "<script>x()</script>".repeat(12500);
    assert.ok(content.length >= 240000);
    const t0 = Date.now();
    await makePage(site.id, { title: "Heavy", content });
    assert.ok(Date.now() - t0 < 3000);
  });
});
