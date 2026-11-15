import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { makePage } from "./ext-helpers.js";
import { query } from "../src/db.js";
import { afterContentChange } from "../src/services/site-sync.js";

describe("site-sync afterContentChange", () => {
  let site;
  before(async () => {
    site = await createTestSite("SiteSync");
  });
  after(async () => { await closeDb(); });

  test("rebuilds blog listing after article published", async () => {
    await makePage(site.id, { url_path: "/blog/sync-article", title: "Sync", content: "x", published: true, post_type: "article", published_at: new Date() });
    await afterContentChange(site.id);
    const r = await query("SELECT id FROM pages WHERE site_id = $1 AND url_path = '/blog' AND managed_by = 'blog_index'", [site.id]);
    assert.equal(r.rows.length, 1);
  });

  test("removes blog listing after article unpublished", async () => {
    await query("UPDATE pages SET published = false WHERE site_id = $1 AND post_type = 'article'", [site.id]);
    await afterContentChange(site.id);
    const r = await query("SELECT id FROM pages WHERE site_id = $1 AND url_path = '/blog' AND managed_by = 'blog_index'", [site.id]);
    assert.equal(r.rows.length, 0);
  });

  test("deleteStaticPaths does not throw", async () => {
    await afterContentChange(site.id, { deleteStaticPaths: ["/nope"] });
    assert.ok(true);
  });
});
