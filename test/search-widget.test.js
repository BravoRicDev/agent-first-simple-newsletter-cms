import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { setBlogConfig, invalidateBlogSettingCache } from "../src/services/blog-settings.js";
import { expandSearch, renderSearchWidget } from "../src/services/search-widget.js";
import { stripAllComments } from "../src/services/comment-strip.js";

describe("search widget (shortcode {{search}})", () => {
  let siteOff, siteOn;
  before(async () => {
    siteOff = await createTestSite("Search Widget Off");
    siteOn = await createTestSite("Search Widget On");
    await setBlogConfig(siteOff.id, { search_enabled: "0" });
    await setBlogConfig(siteOn.id, { search_enabled: "1" });
    invalidateBlogSettingCache(siteOff.id);
    invalidateBlogSettingCache(siteOn.id);
  });
  after(async () => { await closeDb(); });

  test("disabled -> shortcode removed, no widget output", async () => {
    const out = await expandSearch(siteOff.id, "<p>a{{search}}b</p>");
    assert.ok(!out.includes("{{search"));
    assert.ok(!out.includes("cms-search"));
    assert.equal(out, "<p>ab</p>");
  });

  test("enabled -> widget with id cms-search-0 and public search endpoint", async () => {
    const out = await expandSearch(siteOn.id, "<p>{{search}}</p>");
    assert.ok(out.includes('id="cms-search-0"'));
    assert.ok(out.includes("/api/public/search?q="));
  });

  test("two shortcodes -> ids 0 and 1 and exactly one <style>", async () => {
    const out = await expandSearch(siteOn.id, "{{search}} x {{search:Cerca}}");
    assert.ok(out.includes('id="cms-search-0"'));
    assert.ok(out.includes('id="cms-search-1"'));
    assert.equal(out.split("<style>").length - 1, 1);
  });

  test("placeholder with quotes and tags is HTML-escaped", async () => {
    const out = await expandSearch(siteOn.id, '{{search:Cerca "qui" <b>}}');
    assert.ok(out.includes("&quot;"));
    assert.ok(out.includes("&lt;b&gt;"));
    assert.ok(!out.includes("<b>"));
  });

  test("html without shortcode returned unchanged (===)", async () => {
    const html = "<p>nessun widget qui</p>";
    const out = await expandSearch(siteOn.id, html);
    assert.ok(out === html);
  });

  test("generated JS is valid syntax, has no '//', survives stripAllComments", () => {
    const widget = renderSearchWidget("", 0);
    const m = widget.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, "script block present");
    const js = m[1];
    assert.doesNotThrow(() => new Function(js));
    assert.ok(!js.includes("//"));
    assert.ok(js.includes('r.url.charAt(1)==="/"'));
    assert.equal(stripAllComments(js), js);
  });
});
