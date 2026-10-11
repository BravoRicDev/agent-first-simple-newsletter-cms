import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import {
  syncHomepageSections,
  activateHomepageDynamic,
  deactivateHomepageDynamic,
} from "../src/services/homepage-sections.js";

describe("homepage sections sync", () => {
  let site;
  before(async () => { site = await createTestSite("Homepage Sections Test"); });
  after(async () => { await closeDb(); });

  async function getHomepage() {
    return (await query(
      "SELECT * FROM pages WHERE site_id=$1 AND url_path='/' AND published=true",
      [site.id]
    )).rows[0];
  }

  async function createHomepage(content = "CONTENUTO MANUALE ORIGINALE") {
    return (await query(
      `INSERT INTO pages (site_id, url_path, title, content, layout_mode, published, managed_by)
       VALUES ($1, '/', 'Home', $2, 'wrapped', true, NULL)
       RETURNING id, content, updated_at, managed_by`,
      [site.id, content]
    )).rows[0];
  }

  async function addCategory(name, slug) {
    return (await query(
      "INSERT INTO categories (site_id, name, slug) VALUES ($1,$2,$3) RETURNING id",
      [site.id, name, slug]
    )).rows[0].id;
  }

  async function addArticle({ title, categoryId = null, excerpt = "", published = true, content = "<p>Articolo di esempio.</p>" }) {
    return (await query(
      `INSERT INTO pages (site_id, url_path, title, content, post_type, published, category_id, excerpt, published_at, layout_mode)
       VALUES ($1,$2,$3,$4,'article',$5,$6,$7,NOW(),'wrapped') RETURNING id`,
      [site.id, `/articoli-test/${Date.now()}-${Math.random().toString(16).slice(2)}`, title, content, published, categoryId, excerpt]
    )).rows[0].id;
  }

  test("default disabilitato: sync non modifica la homepage", async () => {
    await query("DELETE FROM homepage_sections WHERE site_id=$1", [site.id]);
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const home = await createHomepage();
    await syncHomepageSections(site.id);
    const after = await getHomepage();
    assert.equal(after.content, home.content);
    assert.equal(after.managed_by, null);
    assert.ok(after.updated_at.getTime() === home.updated_at.getTime());
  });

  test("attivazione con seeding: preserve contenuto manuale, imposta managed_by homepage", async () => {
    await query("DELETE FROM homepage_sections WHERE site_id=$1", [site.id]);
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const home = await createHomepage();
    assert.equal(home.content, "CONTENUTO MANUALE ORIGINALE");

    await activateHomepageDynamic(site.id);

    const section = (await query(
      "SELECT * FROM homepage_sections WHERE site_id=$1 AND section_type='custom_html' LIMIT 1",
      [site.id]
    )).rows[0];
    assert.ok(section);
    assert.equal(section.custom_html, "CONTENUTO MANUALE ORIGINALE");
    assert.equal(section.position, 0);
    assert.equal(section.title, "Contenuto esistente");

    const after = await getHomepage();
    assert.equal(after.managed_by, "homepage");
    assert.ok(after.content.includes("CONTENUTO MANUALE ORIGINALE"));
  });

  test("category_band: include solo categorie con almeno un articolo pubblicato", async () => {
    await query("DELETE FROM homepage_sections WHERE site_id=$1", [site.id]);
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    await createHomepage();
    const catWithArticles = await addCategory("Con Articoli", "con-articoli");
    const catWithoutArticles = await addCategory("Senza Articoli", "senza-articoli");
    await addArticle({ title: "Articolo Pubblicato", categoryId: catWithArticles });

    await query(
      `INSERT INTO homepage_sections (site_id, position, section_type, enabled)
       VALUES ($1, 0, 'category_band', true)`,
      [site.id]
    );
    await activateHomepageDynamic(site.id);

    const after = await getHomepage();
    assert.ok(after.content.includes("con-articoli"));
    assert.ok(!after.content.includes("senza-articoli"));
  });

  test("category_feed: rispetta articles_limit", async () => {
    await query("DELETE FROM homepage_sections WHERE site_id=$1", [site.id]);
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    await createHomepage();
    const cat = await addCategory("Feed Test", "feed-test");

    for (let i = 1; i <= 5; i++) {
      await addArticle({ title: `Articolo Feed ${i}`, categoryId: cat });
    }

    await query(
      `INSERT INTO homepage_sections (site_id, position, section_type, category_id, articles_limit, enabled)
       VALUES ($1, 0, 'category_feed', $2, 2, true)`,
      [site.id, cat]
    );
    await activateHomepageDynamic(site.id);

    // Ordine DESC per published_at/id: a parità di timestamp vince l'id più
    // alto, quindi i 2 più recenti (4 e 5) sono quelli entro il limite.
    const after = await getHomepage();
    assert.ok(after.content.includes("Articolo Feed 5"));
    assert.ok(after.content.includes("Articolo Feed 4"));
    assert.ok(!after.content.includes("Articolo Feed 3"));
    assert.ok(!after.content.includes("Articolo Feed 2"));
    assert.ok(!after.content.includes("Articolo Feed 1"));
  });

  test("disattivazione: managed_by torna a NULL, content invariato, sync successiva non tocca nulla", async () => {
    await query("DELETE FROM homepage_sections WHERE site_id=$1", [site.id]);
    await query("DELETE FROM pages WHERE site_id=$1", [site.id]);
    const home = await createHomepage();
    await activateHomepageDynamic(site.id);

    const beforeDeactivate = await getHomepage();
    assert.equal(beforeDeactivate.managed_by, "homepage");

    await deactivateHomepageDynamic(site.id);

    const afterDeactivate = await getHomepage();
    assert.equal(afterDeactivate.managed_by, null);
    assert.equal(afterDeactivate.content, beforeDeactivate.content);
    assert.ok(afterDeactivate.updated_at.getTime() === beforeDeactivate.updated_at.getTime());

    await syncHomepageSections(site.id);

    const afterSync = await getHomepage();
    assert.equal(afterSync.content, afterDeactivate.content);
    assert.ok(afterSync.updated_at.getTime() === afterDeactivate.updated_at.getTime());
  });
});