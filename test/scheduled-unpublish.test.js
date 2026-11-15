import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { makePage, noSmtp } from "./ext-helpers.js";
import { query } from "../src/db.js";
import { runUnpublishDue } from "../src/services/scheduled-unpublish.js";
import { syncBlogListingPages } from "../src/services/blog-index.js";

noSmtp();

describe("scheduled unpublish", () => {
  let site, A, B, C, D;
  before(async () => {
    site = await createTestSite("Unpublish");
    const past = new Date(Date.now() - 60000);
    const future = new Date(Date.now() + 3600000);
    A = await makePage(site.id, { url_path: "/unp-a", title: "A", published: true, extra: { unpublish_at: past } });
    B = await makePage(site.id, { url_path: "/unp-b", title: "B", published: true, extra: { unpublish_at: future } });
    C = await makePage(site.id, { url_path: "/blog/unp-c", title: "C", published: true, post_type: "article", published_at: new Date(), extra: { unpublish_at: future } });
    D = await makePage(site.id, { url_path: "/unp-d", title: "D", published: false, extra: { unpublish_at: past } });
    await syncBlogListingPages(site.id);
    await query("UPDATE pages SET unpublish_at = $1 WHERE id = $2", [past, C.id]);
  });
  after(async () => { await closeDb(); });

  test("unpublishes due pages, keeps the others, cleans the blog listing", async () => {
    const before = await query("SELECT count(*)::int AS n FROM pages WHERE site_id=$1 AND managed_by='blog_index'", [site.id]);
    assert.ok(before.rows[0].n > 0, "blog listing must exist before the run");

    const result = await runUnpublishDue();
    // shared test DB: the scheduler may also unpublish due rows of other test files, so assert >= 2
    assert.ok(result.unpublished >= 2, `expected >= 2, got ${result.unpublished}`);

    const rows = (await query("SELECT id, published, unpublish_at FROM pages WHERE id = ANY($1::int[])", [[A.id, B.id, C.id, D.id]])).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[A.id].published, false);
    assert.equal(byId[A.id].unpublish_at, null);
    assert.equal(byId[C.id].published, false);
    assert.equal(byId[C.id].unpublish_at, null);
    assert.equal(byId[B.id].published, true);
    assert.notEqual(byId[B.id].unpublish_at, null);
    assert.equal(byId[D.id].published, false);
    assert.notEqual(byId[D.id].unpublish_at, null);

    const audit = await query("SELECT count(*)::int AS n FROM audit_log WHERE action='unpublish' AND entity_id = ANY($1::int[])", [[A.id, C.id]]);
    assert.equal(audit.rows[0].n, 2);

    const listing = await query("SELECT count(*)::int AS n FROM pages WHERE site_id=$1 AND managed_by='blog_index'", [site.id]);
    assert.equal(listing.rows[0].n, 0);

    await runUnpublishDue();
    const stillDue = await query("SELECT count(*)::int AS n FROM pages WHERE site_id=$1 AND unpublish_at IS NOT NULL AND unpublish_at <= NOW() AND published = true", [site.id]);
    assert.equal(stillDue.rows[0].n, 0);
  });
});
