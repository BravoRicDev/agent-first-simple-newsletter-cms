import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { makePage, makeCategory } from "./ext-helpers.js";
import { query } from "../src/db.js";
import {
  snapshotPage, getVersion, diffVersions, restoreVersion, MAX_VERSIONS,
} from "../src/services/page-versions.js";

// Generatore pseudo-casuale deterministico (LCG) per dati di test riproducibili.
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function randomLines(n, prefix, rnd) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${prefix}-${Math.floor(rnd() * 1e9).toString(36)}-${i}`);
  return out.join("\n");
}

describe("page-versions service", () => {
  let site, otherSite, user, cat;

  before(async () => {
    site = await createTestSite("PV");
    otherSite = await createTestSite("PV-other");
    user = await createTestUser(site.id, "admin");
    cat = await makeCategory(site.id, "PV Cat", `pv-cat-${Date.now()}`);
  });

  after(async () => { await closeDb(); });

  test("(1) snapshotPage creates a source='agent' row copying title/post_type/category", async () => {
    const page = await makePage(site.id, { title: "T1", post_type: "article", category_id: cat.id, excerpt: "ex" });
    const snap = await snapshotPage(page.id, user.id, { source: "agent", label: "first" });
    assert.ok(snap && snap.id);
    const row = (await query("SELECT * FROM page_versions WHERE id = $1", [snap.id])).rows[0];
    assert.equal(row.source, "agent");
    assert.equal(row.title, "T1");
    assert.equal(row.post_type, "article");
    assert.equal(row.category_id, cat.id);
    assert.equal(row.label, "first");
  });

  test("(2) pruning keeps MAX_VERSIONS new snapshots and never deletes legacy narrow rows", async () => {
    assert.equal(MAX_VERSIONS, 50);
    const page = await makePage(site.id, { title: "Prune" });
    const legacyIds = [];
    for (let i = 0; i < 3; i++) {
      const r = await query(
        `INSERT INTO page_versions (page_id, url_path, title, content, layout_mode, published)
         VALUES ($1, $2, 'legacy', 'old', 'wrapped', true) RETURNING id`,
        [page.id, `/legacy-${i}-${page.id}`]);
      legacyIds.push(r.rows[0].id);
    }
    for (let i = 0; i < 55; i++) await snapshotPage(page.id, user.id, { source: "agent" });
    const newCount = (await query("SELECT COUNT(*)::int AS n FROM page_versions WHERE page_id = $1 AND source IS NOT NULL", [page.id])).rows[0].n;
    assert.equal(newCount, 50);
    const legacyLeft = (await query("SELECT id FROM page_versions WHERE page_id = $1 AND source IS NULL ORDER BY id", [page.id])).rows.map((r) => r.id);
    assert.deepEqual(legacyLeft, legacyIds);
  });

  test("(3) getVersion truncates content to maxChars and reports content_length", async () => {
    const page = await makePage(site.id, { content: "x".repeat(5000) });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    const v = await getVersion(page.id, snap.id, { maxChars: 1000 });
    assert.equal(v.truncated, true);
    assert.equal(v.content.length, 1000);
    assert.equal(v.content_length, 5000);
  });

  test("(4) diffVersions reports changed title, added lines and clean hunk lines", async () => {
    const page = await makePage(site.id, { title: "Before", content: "line1\nline2\nline3" });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    await query("UPDATE pages SET title = 'After', content = $1 WHERE id = $2", ["line1\nline2\nline3\nline4\nline5", page.id]);
    const d = await diffVersions(site.id, page.id, String(snap.id), "current");
    assert.ok(d.changed_fields.some((f) => f.field === "title"));
    assert.ok(d.content.added_lines >= 1);
    assert.ok(d.content.hunks.length >= 1);
    for (const h of d.content.hunks) {
      for (const l of h.lines) assert.ok(/^[ +-]/.test(l), `bad hunk line: ${JSON.stringify(l)}`);
    }
  });

  test("(5) diffVersions with tiny maxChars is truncated", async () => {
    const rnd = seeded(7);
    const page = await makePage(site.id, { content: randomLines(200, "old", rnd) });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    await query("UPDATE pages SET content = $1 WHERE id = $2", [randomLines(200, "new", rnd), page.id]);
    const d = await diffVersions(site.id, page.id, String(snap.id), "current", { maxChars: 10 });
    assert.equal(d.content.truncated, true);
  });

  test("(6) restoreVersion of a full article snapshot restores category/excerpt/post_type and snapshots before-restore", async () => {
    const page = await makePage(site.id, { post_type: "article", category_id: cat.id, excerpt: "orig-ex", title: "R6" });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    await query("UPDATE pages SET post_type = 'page', category_id = NULL, excerpt = 'changed' WHERE id = $1", [page.id]);
    const out = await restoreVersion(site.id, page.id, snap.id, user.id);
    assert.equal(out.page.post_type, "article");
    assert.equal(out.page.category_id, cat.id);
    assert.equal(out.page.excerpt, "orig-ex");
    assert.equal(out.touchedArticle, true);
    const extra = (await query("SELECT COUNT(*)::int AS n FROM page_versions WHERE page_id = $1 AND label = $2", [page.id, `before-restore-${snap.id}`])).rows[0].n;
    assert.equal(extra, 1);
    assert.ok(out.snapshot_id);
  });

  test("(7) restoring a legacy narrow row leaves post_type/category/excerpt untouched", async () => {
    const page = await makePage(site.id, { post_type: "article", category_id: cat.id, excerpt: "keep-me", title: "R7" });
    const legacy = await query(
      `INSERT INTO page_versions (page_id, url_path, title, content, layout_mode, published)
       VALUES ($1, $2, 'legacy-title', 'legacy-content', 'wrapped', true) RETURNING id`,
      [page.id, `/legacy7-${page.id}`]);
    const out = await restoreVersion(site.id, page.id, legacy.rows[0].id, user.id);
    assert.equal(out.page.title, "legacy-title");
    assert.equal(out.page.post_type, "article");
    assert.equal(out.page.category_id, cat.id);
    assert.equal(out.page.excerpt, "keep-me");
  });

  test("(8) expectedUpdatedAt mismatch rejects with STALE and leaves page unchanged", async () => {
    const page = await makePage(site.id, { title: "R8" });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    await query("UPDATE pages SET title = 'R8-changed' WHERE id = $1", [page.id]);
    await assert.rejects(
      restoreVersion(site.id, page.id, snap.id, user.id, { expectedUpdatedAt: new Date(0).toISOString() }),
      (e) => e.code === "STALE");
    const now = (await query("SELECT title FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(now.title, "R8-changed");
  });

  test("(9) url_path collision rejects with 23505 and rolls back", async () => {
    const other = await makePage(site.id, { url_path: `/pv9-taken-${Date.now()}`, title: "Other" });
    const page = await makePage(site.id, { title: "R9" });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    await query("UPDATE page_versions SET url_path = $1 WHERE id = $2", [other.url_path, snap.id]);
    await query("UPDATE pages SET title = 'R9-changed' WHERE id = $1", [page.id]);
    await assert.rejects(restoreVersion(site.id, page.id, snap.id, user.id), (e) => e.code === "23505");
    const now = (await query("SELECT title, url_path FROM pages WHERE id = $1", [page.id])).rows[0];
    assert.equal(now.title, "R9-changed");
    assert.notEqual(now.url_path, other.url_path);
  });

  test("(10) wrong site id gives PAGE_NOT_FOUND", async () => {
    const page = await makePage(site.id, { title: "R10" });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    await assert.rejects(restoreVersion(otherSite.id, page.id, snap.id, user.id), (e) => e.code === "PAGE_NOT_FOUND");
    await assert.rejects(diffVersions(otherSite.id, page.id, String(snap.id), "current"), (e) => e.code === "PAGE_NOT_FOUND");
  });

  test("(11) huge diff returns quickly with too_large_to_diff; identical content reports identical", async () => {
    const rnd = seeded(42);
    const page = await makePage(site.id, { content: randomLines(20000, "alpha", rnd) });
    const snap = await snapshotPage(page.id, user.id, { source: "agent" });
    await query("UPDATE pages SET content = $1 WHERE id = $2", [randomLines(20000, "beta", rnd), page.id]);
    const t0 = Date.now();
    const d = await diffVersions(site.id, page.id, String(snap.id), "current");
    assert.ok(Date.now() - t0 < 5000, "diff took too long");
    assert.equal(d.content.too_large_to_diff, true);
    assert.equal(d.content.hunks.length, 0);

    const same = await makePage(site.id, { content: "same\ntext" });
    const s2 = await snapshotPage(same.id, user.id, { source: "agent" });
    const d2 = await diffVersions(site.id, same.id, String(s2.id), "current");
    assert.equal(d2.content.identical, true);
  });
});
