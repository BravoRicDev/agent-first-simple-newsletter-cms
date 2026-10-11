import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { getBlogConfig, setBlogConfig } from "../src/services/blog-settings.js";
import { renderCardTemplate } from "../src/services/blog-index.js";

describe("blog settings per sito e rendering card", () => {
  let site;
  before(async () => { site = await createTestSite("Blog Settings Test"); });
  after(async () => { await closeDb(); });

  test("default completi quando il sito non ha configurazione", async () => {
    const config = await getBlogConfig(site.id);
    assert.equal(config.blog_articles_per_page, "10");
    assert.match(config.blog_card_template, /{{title}}/);
    assert.equal(config.blog_index_title, "Blog");
    assert.equal(config.blog_index_intro_html, "");
  });

  test("set/get salva e rilegge la configurazione del sito", async () => {
    await setBlogConfig(site.id, {
      blog_articles_per_page: "5", blog_card_template: "<h2>{{title}}</h2>",
      blog_index_title: "Blog test", blog_index_intro_html: "<p>Intro</p>",
    });
    const config = await getBlogConfig(site.id);
    assert.equal(config.blog_articles_per_page, "5");
    assert.equal(config.blog_card_template, "<h2>{{title}}</h2>");
    assert.equal(config.blog_index_title, "Blog test");
    assert.equal(config.blog_index_intro_html, "<p>Intro</p>");
  });

  test("l'HTML nei placeholder è escapato", () => {
    const output = renderCardTemplate("<h2>{{title}}</h2>", { title: "Titolo <script>alert(1)</script>" });
    assert.equal(output, "<h2>Titolo &lt;script&gt;alert(1)&lt;/script&gt;</h2>");
  });
});
