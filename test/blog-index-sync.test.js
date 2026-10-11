import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import { deriveExcerptFromContent, syncBlogListingPages } from "../src/services/blog-index.js";

describe("syncBlogListingPages", () => {
  let site;
  before(async () => { site = await createTestSite("Blog Index Sync Test"); });
  after(async () => { await closeDb(); });

  async function addCategory(name, slug) {
    return (await query("INSERT INTO categories (site_id,name,slug) VALUES ($1,$2,$3) RETURNING id", [site.id, name, slug])).rows[0].id;
  }
  async function addArticle({ title, categoryId = null, excerpt = "", published = true, content = "<p>Testo articolo di esempio.</p>" }) {
    return (await query(
      `INSERT INTO pages (site_id,url_path,title,content,post_type,published,category_id,excerpt,published_at,layout_mode)
       VALUES ($1,$2,$3,$4,'article',$5,$6,$7,NOW(),'wrapped') RETURNING id`,
      [site.id, `/articoli/${Date.now()}-${Math.random().toString(16).slice(2)}`, title, content, published, categoryId, excerpt]
    )).rows[0].id;
  }
  async function listing(urlPath) {
    return (await query("SELECT * FROM pages WHERE site_id=$1 AND url_path=$2", [site.id, urlPath])).rows[0];
  }

  test("nessun articolo: non crea indice e la sync a vuoto è sicura", async () => {
    await syncBlogListingPages(site.id);
    assert.equal(await listing("/blog"), undefined);
  });

  test("un numero sotto soglia crea una sola pagina indice", async () => {
    await setBlogConfig(site.id, { blog_articles_per_page: "3" });
    await addArticle({ title: "Uno" });
    await addArticle({ title: "Due" });
    await syncBlogListingPages(site.id);
    assert.ok(await listing("/blog"));
    assert.equal(await listing("/blog/pagina/2"), undefined);
  });

  test("sopra soglia crea le pagine corrette, rispetta excerpt e fallback", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    await setBlogConfig(site.id, { blog_articles_per_page: "2" });
    const categoryId = await addCategory("Prove", "prove");
    await addArticle({ title: "Excerpt custom", categoryId, excerpt: "Descrizione salvata" });
    await addArticle({ title: "Excerpt derivato", categoryId, content: "<script>ignora</script><p>Testo <b>derivato</b> dalla pagina.</p>" });
    await addArticle({ title: "Terzo" });
    await syncBlogListingPages(site.id);
    assert.ok(await listing("/blog/pagina/2"));
    assert.equal((await query("SELECT count(*)::int AS n FROM pages WHERE site_id=$1 AND managed_by='blog_index'", [site.id])).rows[0].n, 2);
    assert.ok((await listing("/blog/categoria/prove")).content.includes("Descrizione salvata"));
    assert.ok((await listing("/blog/categoria/prove")).content.includes("Testo derivato dalla pagina."));
    assert.ok(await listing("/blog/categoria/prove"));
    assert.equal(deriveExcerptFromContent("<p>fallback</p>"), "fallback");
  });

  test("un articolo non pubblicato esce e categoria ormai vuota viene cancellata", async () => {
    const categoryId = await addCategory("Senza articoli", "senza-articoli");
    const articleId = await addArticle({ title: "Da togliere", categoryId });
    await syncBlogListingPages(site.id);
    assert.ok(await listing("/blog/categoria/senza-articoli"));
    await query("UPDATE pages SET published=false WHERE id=$1", [articleId]);
    await syncBlogListingPages(site.id);
    assert.equal(await listing("/blog/categoria/senza-articoli"), undefined);
  });

  test("sostituisce tutte le occorrenze di {{image}} nel template", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    await setBlogConfig(site.id, {
      blog_card_template: "<div style=\"background-image: url('{{image}}')\">{{image}}</div>",
    });
    const articleId = await addArticle({ title: "Due immagini" });
    await query("UPDATE pages SET featured_image=$1 WHERE id=$2", ["/uploads/foto.jpg", articleId]);
    await syncBlogListingPages(site.id);
    const content = (await listing("/blog")).content;
    assert.equal(content.match(/<img src=\"\/uploads\/foto.jpg\" alt=\"\">/g)?.length, 2);
    assert.ok(!content.includes("BLOG_IMAGE_BLOCK_TOKEN"));
  });

  test("una pagina manuale /blog non viene mai sovrascritta", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    await query("INSERT INTO pages (site_id,url_path,title,content,published,managed_by) VALUES ($1,'/blog','Manuale','ORIGINALE',true,NULL)", [site.id]);
    await addArticle({ title: "Non sovrascrivere" });
    await syncBlogListingPages(site.id);
    assert.equal((await listing("/blog")).content, "ORIGINALE");
  });
});
