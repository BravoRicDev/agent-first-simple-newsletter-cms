import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { expandArticleLists } from "../src/services/page-renderer.js";
import { setBlogConfig } from "../src/services/blog-settings.js";

describe("expandArticleLists (snippet {{articles:...}})", () => {
  let site;
  before(async () => { site = await createTestSite("Article Snippet Test"); });
  after(async () => { await closeDb(); });

  async function addCategory(name, slug, extra = {}) {
    return (await query(
      `INSERT INTO categories (site_id,name,slug,color,icon,custom_css)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [site.id, name, slug, extra.color || null, extra.icon || null, extra.customCss || null]
    )).rows[0].id;
  }
  async function addArticle({ title, categoryId = null, published = true, publishedAt = "NOW()", excerpt = "", content = "<p>Testo articolo di esempio per l'estratto.</p>" }) {
    return (await query(
      `INSERT INTO pages (site_id,url_path,title,content,post_type,published,category_id,excerpt,published_at,layout_mode)
       VALUES ($1,$2,$3,$4,'article',$5,$6,$7,$8,'wrapped') RETURNING id`,
      [site.id, `/articoli/${Date.now()}-${Math.random().toString(16).slice(2)}`, title, content, published, categoryId, excerpt, publishedAt]
    )).rows[0].id;
  }
  function countCards(html) {
    return (html.match(/<article/g) || []).length;
  }

  test("category=viaggi|limit=3 con più di 3 articoli: 3 card, più recente prima", async () => {
    const categoryId = await addCategory("Viaggi", "viaggi");
    const days = ["01", "02", "03", "04", "05"];
    for (let i = 0; i < 5; i++) {
      await addArticle({ title: `Viaggi ${i + 1}`, categoryId, publishedAt: `'2024-01-${days[i]}T10:00:00Z'` });
    }
    const html = await expandArticleLists(site.id, "<div>{{articles:category=viaggi|limit=3}}</div>");
    assert.equal(countCards(html), 3);
    assert.ok(html.includes("Viaggi 5"));
    assert.ok(html.includes("Viaggi 4"));
    assert.ok(html.includes("Viaggi 3"));
    assert.ok(!html.includes("Viaggi 2"));
    assert.ok(!html.includes("Viaggi 1"));
    // Ordine decrescente per published_at: 5 prima di 4 prima di 3
    assert.ok(html.indexOf("Viaggi 5") < html.indexOf("Viaggi 4"));
    assert.ok(html.indexOf("Viaggi 4") < html.indexOf("Viaggi 3"));
  });

  test("{{articles}} nudo: default limit 6, tutte le categorie, nessun filtro", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const alfa = await addCategory("Alfa", "alfa");
    const beta = await addCategory("Beta", "beta");
    // 4+4 articoli, i primi 6 per published_at includono entrambe le categorie
    const pairs = [["Alfa 1", alfa], ["Beta 1", beta], ["Alfa 2", alfa], ["Beta 2", beta],
      ["Alfa 3", alfa], ["Beta 3", beta], ["Alfa 4", alfa], ["Beta 4", beta]];
    for (let i = 0; i < pairs.length; i++) {
      const dd = String(10 - i).padStart(2, "0");
      await addArticle({ title: pairs[i][0], categoryId: pairs[i][1], publishedAt: `'2024-02-${dd}T10:00:00Z'` });
    }
    const html = await expandArticleLists(site.id, "<div>{{articles}}</div>");
    assert.equal(countCards(html), 6);
    assert.ok(html.includes("Alfa 1"));
    assert.ok(html.includes("Beta 1"));
    assert.ok(!html.includes("Alfa 4"));
  });

  test("categoria con slug inesistente per il sito: placeholder lasciato invariato", async () => {
    const html = await expandArticleLists(site.id, "<div>{{articles:category=non-esiste}}</div>");
    assert.ok(html.includes("{{articles:category=non-esiste}}"));
  });

  test("limit=10000 viene clampato al tetto massimo (500), limit=3 non viene toccato", async () => {
    const categoryId = await addCategory("Molti", "molti");
    for (let i = 0; i < 25; i++) {
      const dd = String((i % 27) + 1).padStart(2, "0");
      await addArticle({ title: `Molti ${i}`, categoryId, publishedAt: `'2023-01-${dd}T10:00:00Z'` });
    }
    const html = await expandArticleLists(site.id, "<div>{{articles:category=molti|limit=10000}}</div>");
    assert.equal(countCards(html), 25); // meno del tetto: nessun clamp, tutti i 25 articoli
    const limited = await expandArticleLists(site.id, "<div>{{articles:category=molti|limit=3}}</div>");
    assert.equal(countCards(limited), 3);
  });

  test("show_date=false toglie la data; default/true la mostra", async () => {
    const categoryId = await addCategory("Date", "date");
    await addArticle({ title: "Con data", categoryId, publishedAt: "'2024-03-15T12:00:00Z'" });
    const withoutDate = await expandArticleLists(site.id, "{{articles:category=date|show_date=false}}");
    assert.equal(countCards(withoutDate), 1);
    assert.ok(!withoutDate.includes("15/03/2024"));
    const withDate = await expandArticleLists(site.id, "{{articles:category=date|show_date=true}}");
    assert.ok(withDate.includes("15/03/2024"));
    const defaultDate = await expandArticleLists(site.id, "{{articles:category=date}}");
    assert.ok(defaultDate.includes("15/03/2024"));
  });

  test("categoria valida ma senza articoli pubblicati: stringa vuota al posto del placeholder", async () => {
    await addCategory("Vuota", "vuota");
    const html = await expandArticleLists(site.id, "<div>{{articles:category=vuota}}</div>");
    assert.equal(html, "<div></div>");
    assert.ok(!html.includes("{{articles:category=vuota}}"));
  });

  test("due blocchi con categorie diverse nella stessa pagina: nessuna interferenza", async () => {
    // "viaggi" è stata svuotata dal DELETE della pagina precedente: ricrea
    // gli articoli necessari invece di assumere lo stato lasciato dal primo
    // test (la categoria "viaggi" stessa resta, solo le sue pagine erano state
    // cancellate).
    const viaggi = (await query("SELECT id FROM categories WHERE site_id=$1 AND slug='viaggi'", [site.id])).rows[0].id;
    await addArticle({ title: "Viaggi 5", categoryId: viaggi, publishedAt: "'2024-01-05T10:00:00Z'" });
    await addArticle({ title: "Viaggi 4", categoryId: viaggi, publishedAt: "'2024-01-04T10:00:00Z'" });
    const cibo = await addCategory("Cibo", "cibo");
    await addArticle({ title: "Ricetta speciale cibo", categoryId: cibo, publishedAt: "'2024-04-01T10:00:00Z'" });
    await addArticle({ title: "Seconda ricetta cibo", categoryId: cibo, publishedAt: "'2024-04-02T10:00:00Z'" });
    const html = await expandArticleLists(
      site.id,
      "<p>INIZIO</p>{{articles:category=cibo|limit=1}}<p>MEZZO</p>{{articles:category=viaggi|limit=2}}<p>FINE</p>"
    );
    const prima = html.slice(0, html.indexOf("MEZZO"));
    const dopo = html.slice(html.indexOf("MEZZO"));
    assert.equal(countCards(prima), 1);
    assert.ok(prima.includes("Seconda ricetta cibo"));
    assert.ok(!prima.includes("Viaggi"));
    assert.ok(!prima.includes("Ricetta speciale cibo"));
    assert.equal(countCards(dopo), 2);
    assert.ok(dopo.includes("Viaggi 5"));
    assert.ok(dopo.includes("Viaggi 4"));
    assert.ok(!dopo.includes("cibo"));
  });

  test("custom_css della categoria: <style> iniettato; data-category SOLO con enable_client_filter=true", async () => {
    const css = '[data-category="viaggi"] { border-color: #1e40af; }';
    await query("UPDATE categories SET custom_css=$1 WHERE site_id=$2 AND slug='viaggi'", [css, site.id]);
    const withoutFilter = await expandArticleLists(site.id, "{{articles:category=viaggi|limit=1}}");
    assert.ok(withoutFilter.includes(`<style>${css}</style>`));
    // Nota: "data-category" compare comunque nel testo del CSS iniettato
    // (è il selettore scritto dall'owner); controlla l'ATTRIBUTO sul tag,
    // non la sottostringa grezza.
    assert.ok(!withoutFilter.includes('<article data-category='), "default: nessun data-category senza enable_client_filter");
    const withFilter = await expandArticleLists(site.id, "{{articles:category=viaggi|limit=1|enable_client_filter=true}}");
    assert.ok(withFilter.includes('<article data-category="viaggi"'));
  });

  test("category=cat1,cat2: articoli di entrambe le categorie, ordinati per data", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const cat1 = await addCategory("Cat Uno", "cat1");
    const cat2 = await addCategory("Cat Due", "cat2");
    await addArticle({ title: "Uno vecchio", categoryId: cat1, publishedAt: "'2024-05-01T10:00:00Z'" });
    await addArticle({ title: "Due nuovo", categoryId: cat2, publishedAt: "'2024-05-03T10:00:00Z'" });
    await addArticle({ title: "Uno nuovo", categoryId: cat1, publishedAt: "'2024-05-02T10:00:00Z'" });
    const html = await expandArticleLists(site.id, "{{articles:category=cat1,cat2}}");
    assert.equal(countCards(html), 3);
    assert.ok(html.includes("Uno vecchio"));
    assert.ok(html.includes("Due nuovo"));
    assert.ok(html.includes("Uno nuovo"));
    // Ordine decrescente per published_at: Due nuovo (03) > Uno nuovo (02) > Uno vecchio (01)
    assert.ok(html.indexOf("Due nuovo") < html.indexOf("Uno nuovo"));
    assert.ok(html.indexOf("Uno nuovo") < html.indexOf("Uno vecchio"));
  });

  test("category=cat1,slug-inesistente: un solo slug mancante blocca l'intera combinazione", async () => {
    const html = await expandArticleLists(site.id, "{{articles:category=cat1,categoria-che-non-esiste}}");
    assert.ok(html.includes("{{articles:category=cat1,categoria-che-non-esiste}}"));
  });

  test("date_from/date_to: solo gli articoli nel range (estremi inclusi)", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const range = await addCategory("Range", "range");
    await addArticle({ title: "Fuori prima", categoryId: range, publishedAt: "'2024-06-01T10:00:00Z'" });
    await addArticle({ title: "Dentro 1", categoryId: range, publishedAt: "'2024-06-10T10:00:00Z'" });
    await addArticle({ title: "Dentro 2", categoryId: range, publishedAt: "'2024-06-15T10:00:00Z'" });
    await addArticle({ title: "Fuori dopo", categoryId: range, publishedAt: "'2024-06-20T10:00:00Z'" });
    const html = await expandArticleLists(site.id, "{{articles:category=range|date_from=2024-06-05|date_to=2024-06-15}}");
    assert.equal(countCards(html), 2);
    assert.ok(html.includes("Dentro 1"));
    assert.ok(html.includes("Dentro 2"));
    assert.ok(!html.includes("Fuori prima"));
    assert.ok(!html.includes("Fuori dopo"));
  });

  test("date_from con formato non valido: parametro ignorato silenziosamente", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const cat = await addCategory("DateTest", "datetest");
    await addArticle({ title: "DT A", categoryId: cat, publishedAt: "'2024-07-01T10:00:00Z'" });
    await addArticle({ title: "DT B", categoryId: cat, publishedAt: "'2024-07-02T10:00:00Z'" });
    const withInvalid = await expandArticleLists(site.id, "{{articles:category=datetest|date_from=non-una-data}}");
    const noParam = await expandArticleLists(site.id, "{{articles:category=datetest}}");
    // Comportamento identico a "parametro assente": nessun errore, entrambi gli articoli.
    assert.equal(withInvalid, noParam);
    assert.equal(countCards(withInvalid), 2);
  });

  test("card_template_override con nuovi placeholder: reading_time, published_at_short, category_slug, category_icon", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const cat = await addCategory("Tech", "tech", { icon: "💻" });
    await addArticle({
      title: "Articolo Tech",
      categoryId: cat,
      publishedAt: "'2024-09-25T10:00:00Z'",
      content: "<p>" + "word ".repeat(400).trim() + "</p>",
    });
    await setBlogConfig(site.id, {
      blog_card_template: '<article><span class="tag {{category_slug}}"><span class="zh">{{category_icon}}</span></span><span>{{published_at_short}}</span><span>{{reading_time}} min</span></article>',
    });
    const html = await expandArticleLists(site.id, "{{articles:category=tech}}");
    assert.ok(html.includes('<span class="tag tech">'), "category_slug non popolato");
    assert.ok(html.includes('<span class="zh">💻</span>'), "category_icon non popolata");
    assert.ok(html.includes('<span>25 set</span>'), "published_at_short non popolato");
    assert.ok(html.includes('<span>2 min</span>'), "reading_time non popolato (400 parole / 200wpm = 2)");
  });

  test("image_url: URL nudo escapato, per template che vogliono un <img> custom (alt/style propri)", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const cat = await addCategory("ImgTest", "imgtest");
    const articleId = await addArticle({ title: "Con immagine", categoryId: cat, publishedAt: "'2024-10-01T10:00:00Z'" });
    await query("UPDATE pages SET featured_image=$1 WHERE id=$2", ["/media/7/foto.jpg", articleId]);
    await setBlogConfig(site.id, {
      blog_card_template: '<article><img src="{{image_url}}" alt="{{title}}" loading="lazy"></article>',
    });
    const html = await expandArticleLists(site.id, "{{articles:category=imgtest}}");
    assert.ok(html.includes('<img src="/media/7/foto.jpg" alt="Con immagine" loading="lazy">'));
  });

  test("reading_time_minutes esplicito sovrascrive la stima automatica", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const cat = await addCategory("Override", "override");
    const withOverrideId = await addArticle({
      title: "Con override", categoryId: cat, publishedAt: "'2024-08-01T10:00:00Z'",
      content: "<p>" + "word ".repeat(2000).trim() + "</p>", // stimerebbe ~10 min
    });
    await query("UPDATE pages SET reading_time_minutes=1 WHERE id=$1", [withOverrideId]);
    await addArticle({
      title: "Senza override", categoryId: cat, publishedAt: "'2024-08-02T10:00:00Z'",
      content: "<p>" + "word ".repeat(2000).trim() + "</p>",
    });
    await setBlogConfig(site.id, { blog_card_template: "<article>{{title}}: {{reading_time}} min</article>" });
    const html = await expandArticleLists(site.id, "{{articles:category=override}}");
    assert.ok(html.includes("Con override: 1 min"), "l'override esplicito deve vincere sulla stima");
    assert.ok(html.includes("Senza override: 10 min"), "senza override resta la stima automatica");
  });

  test("card_title esplicito sovrascrive title SOLO nelle liste", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const cat = await addCategory("CardTitle", "cardtitle");
    const articleId = await addArticle({ title: "Titolo SEO lungo - VicChina", categoryId: cat, publishedAt: "'2024-09-01T10:00:00Z'" });
    await query("UPDATE pages SET card_title='Titolo breve' WHERE id=$1", [articleId]);
    await setBlogConfig(site.id, { blog_card_template: "<article>{{title}}</article>" });
    const html = await expandArticleLists(site.id, "{{articles:category=cardtitle}}");
    assert.ok(html.includes("<article>Titolo breve</article>"));
    assert.ok(!html.includes("Titolo SEO lungo"));
  });

  test("card_html_override: usa l'HTML verbatim al posto del template per quell'articolo", async () => {
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const cat = await addCategory("Override", "htmloverride");
    const normalId = await addArticle({ title: "Normale", categoryId: cat, publishedAt: "'2024-10-01T10:00:00Z'" });
    const frozenId = await addArticle({ title: "Storico", categoryId: cat, publishedAt: "'2024-10-02T10:00:00Z'" });
    const verbatim = '<article class="legacy-card" data-weird-spacing="  yes">HTML congelato storico</article>';
    await query("UPDATE pages SET card_html_override=$1 WHERE id=$2", [verbatim, frozenId]);
    await setBlogConfig(site.id, { blog_card_template: "<article>{{title}}</article>" });
    const html = await expandArticleLists(site.id, "{{articles:category=htmloverride}}");
    assert.ok(html.includes(verbatim), "l'articolo con override deve apparire byte-identico");
    assert.ok(html.includes("<article>Normale</article>"), "l'articolo senza override usa comunque il template");
  });
});
