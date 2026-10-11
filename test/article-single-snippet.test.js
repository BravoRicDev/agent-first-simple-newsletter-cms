import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { expandSingleArticles } from "../src/services/page-renderer.js";

describe("expandSingleArticles (snippet {{article:...}})", () => {
  let site;
  before(async () => { site = await createTestSite("Article Single Snippet Test"); });
  after(async () => { await closeDb(); });

  async function addCategory(name, slug, extra = {}) {
    return (await query(
      `INSERT INTO categories (site_id,name,slug,color,icon,custom_css)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [site.id, name, slug, extra.color || null, extra.icon || null, extra.customCss || null]
    )).rows[0].id;
  }
  async function addArticle({ urlPath, title, categoryId = null, published = true, publishedAt = "NOW()", excerpt = "", content = "<p>Testo articolo di esempio.</p>" }) {
    return (await query(
      `INSERT INTO pages (site_id,url_path,title,content,post_type,published,category_id,excerpt,published_at,layout_mode)
       VALUES ($1,$2,$3,$4,'article',$5,$6,$7,$8,'wrapped') RETURNING id`,
      [site.id, urlPath, title, content, published, categoryId, excerpt, publishedAt]
    )).rows[0].id;
  }

  test("{{article:/url/esistente}}: HTML dell'articolo con titolo, contenuto e data", async () => {
    const categoryId = await addCategory("Viaggi", "viaggi");
    await addArticle({
      urlPath: "/articoli/il-mio-pezzo",
      title: "Il mio pezzo",
      categoryId,
      publishedAt: "'2024-03-15T10:00:00Z'",
      content: "<p>Corpo completo dell'articolo.</p>",
    });
    const html = await expandSingleArticles(site.id, "<div>{{article:/articoli/il-mio-pezzo}}</div>");
    assert.ok(html.includes("Il mio pezzo"));
    assert.ok(html.includes("Corpo completo dell'articolo."));
    assert.ok(html.includes("15/03/2024"));
    // data-category viene iniettato subito dopo il nome del tag, quindi
    // class="article-embed" non è più il primo attributo del tag <article>.
    assert.ok(html.includes("<article"));
    assert.ok(html.includes('class="article-embed"'));
    assert.ok(!html.includes("{{article:"));
  });

  test("url_path inesistente: placeholder lasciato invariato", async () => {
    const html = await expandSingleArticles(site.id, "<div>{{article:/articoli/non-esiste}}</div>");
    assert.ok(html.includes("{{article:/articoli/non-esiste}}"));
  });

  test("categoria con custom_css: <style> iniettato (nessun data-category per l'embed del singolo articolo)", async () => {
    const css = '[data-category="cibo"] { border-color: #b45309; }';
    const categoryId = await addCategory("Cibo", "cibo", { customCss: css });
    await addArticle({
      urlPath: "/articoli/ricetta",
      title: "Ricetta",
      categoryId,
      publishedAt: "'2024-04-01T10:00:00Z'",
      content: "<p>Ricetta completa.</p>",
    });
    const html = await expandSingleArticles(site.id, "{{article:/articoli/ricetta}}");
    assert.ok(html.includes(`<style>${css}</style>`));
    // "data-category" compare nel testo del CSS (selettore scritto
    // dall'owner): controlla l'ATTRIBUTO sul tag, non la sottostringa grezza.
    assert.ok(!html.includes('<article data-category='));
  });

  test("content HTML dell'articolo NON viene escapato", async () => {
    const categoryId = await addCategory("Tech", "tech");
    await addArticle({
      urlPath: "/articoli/html-intatto",
      title: "HTML intatto",
      categoryId,
      publishedAt: "'2024-05-01T10:00:00Z'",
      content: "<p>Testo con <b>grassetto</b> e <em>corsivo</em> nell'HTML originale.</p>",
    });
    const html = await expandSingleArticles(site.id, "{{article:/articoli/html-intatto}}");
    assert.ok(html.includes("<b>grassetto</b>"));
    assert.ok(html.includes("<em>corsivo</em>"));
    assert.ok(!html.includes("&lt;b&gt;grassetto&lt;/b&gt;"));
    assert.ok(!html.includes("&lt;em&gt;corsivo&lt;/em&gt;"));
  });

  test("card_title viene ignorato: l'embed del singolo articolo usa sempre title", async () => {
    const articleId = await addArticle({
      urlPath: "/articoli/con-card-title", title: "Titolo pagina completo",
      publishedAt: "'2024-06-01T10:00:00Z'",
    });
    await query("UPDATE pages SET card_title='Titolo breve card' WHERE id=$1", [articleId]);
    const html = await expandSingleArticles(site.id, "{{article:/articoli/con-card-title}}");
    assert.ok(html.includes("Titolo pagina completo"));
    assert.ok(!html.includes("Titolo breve card"));
  });
});
