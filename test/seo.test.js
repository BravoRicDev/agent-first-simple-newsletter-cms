import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { getSiteSeoConfig, setSiteSeoConfig } from "../src/services/site-seo.js";
import {
  getPublishedPagesForSitemap, buildSitemapXml, buildRobotsTxt,
  buildCanonicalUrl, toAbsoluteUrl, injectSeoIntoStandalone,
} from "../src/services/seo.js";

describe("seo: config sito, robots.txt, sitemap, canonical", () => {
  let site;

  before(async () => { site = await createTestSite("SEO Test"); });
  after(async () => { await closeDb(); });

  test("sito senza config: campi vuoti", async () => {
    const c = await getSiteSeoConfig(site.id);
    assert.equal(c.defaultOgImage, "");
    assert.equal(c.twitterHandle, "");
    assert.equal(c.robotsExtra, "");
  });

  test("setSiteSeoConfig / getSiteSeoConfig: round-trip", async () => {
    await setSiteSeoConfig(site.id, { defaultOgImage: "/media/1/cover.jpg", twitterHandle: "@example" });
    const c = await getSiteSeoConfig(site.id);
    assert.equal(c.defaultOgImage, "/media/1/cover.jpg");
    assert.equal(c.twitterHandle, "@example");
  });

  test("buildRobotsTxt: senza regole extra, formato di base", () => {
    const txt = buildRobotsTxt("https://example.test");
    assert.match(txt, /^User-agent: \*\nAllow: \/\n/);
    assert.match(txt, /Sitemap: https:\/\/example\.test\/sitemap\.xml\n$/);
  });

  test("buildRobotsTxt: righe extra valide (incl. blocco User-agent per bot specifico)", () => {
    const extra = "User-agent: GPTBot\nDisallow: /\n# commento\nCrawl-delay: 5";
    const txt = buildRobotsTxt("https://example.test", extra);
    assert.match(txt, /User-agent: GPTBot/);
    assert.match(txt, /Disallow: \//);
    assert.match(txt, /# commento/);
    assert.match(txt, /Crawl-delay: 5/);
  });

  test("buildRobotsTxt: riga non conforme viene scartata, non corrompe il file", () => {
    const extra = "Disallow: /segreto\nquesta riga non è una direttiva valida\nAllow: /ok";
    const txt = buildRobotsTxt("https://example.test", extra);
    assert.match(txt, /Disallow: \/segreto/);
    assert.match(txt, /Allow: \/ok/);
    assert.doesNotMatch(txt, /questa riga non è una direttiva valida/);
  });

  test("toAbsoluteUrl: lascia invariati URL già assoluti, normalizza quelli relativi", () => {
    assert.equal(toAbsoluteUrl("https://example.test", "https://cdn.test/x.jpg"), "https://cdn.test/x.jpg");
    assert.equal(toAbsoluteUrl("https://example.test", "/media/1/x.jpg"), "https://example.test/media/1/x.jpg");
    assert.equal(toAbsoluteUrl("https://example.test/", "media/1/x.jpg"), "https://example.test/media/1/x.jpg");
    assert.equal(toAbsoluteUrl("https://example.test", ""), "");
  });

  test("buildCanonicalUrl: override esplicito vince, altrimenti self-referencing", () => {
    assert.equal(buildCanonicalUrl("https://example.test", "/chi-siamo", null), "https://example.test/chi-siamo");
    assert.equal(
      buildCanonicalUrl("https://example.test", "/chi-siamo", "https://altro.test/pagina"),
      "https://altro.test/pagina"
    );
    // override relativo: normalizzato in assoluto rispetto al baseUrl
    assert.equal(buildCanonicalUrl("https://example.test", "/chi-siamo", "/altra-pagina"), "https://example.test/altra-pagina");
  });

  test("getPublishedPagesForSitemap: esclude le pagine noindex", async () => {
    const p1 = (await query(
      "INSERT INTO pages (site_id, url_path, title, published) VALUES ($1, '/visibile', 'Visibile', true) RETURNING id",
      [site.id]
    )).rows[0];
    const p2 = (await query(
      "INSERT INTO pages (site_id, url_path, title, published) VALUES ($1, '/nascosta', 'Nascosta', true) RETURNING id",
      [site.id]
    )).rows[0];
    await query(
      "INSERT INTO page_seo (page_id, noindex, og_image) VALUES ($1, true, NULL)",
      [p2.id]
    );
    await query(
      "INSERT INTO page_seo (page_id, noindex, og_image) VALUES ($1, false, '/media/1/cover.jpg')",
      [p1.id]
    );

    const pages = await getPublishedPagesForSitemap(site.id);
    const paths = pages.map(p => p.url_path);
    assert.ok(paths.includes("/visibile"));
    assert.ok(!paths.includes("/nascosta"), "una pagina noindex non deve comparire in sitemap");

    const xml = buildSitemapXml("https://example.test", pages);
    assert.match(xml, /<loc>https:\/\/example\.test\/visibile<\/loc>/);
    assert.doesNotMatch(xml, /nascosta/);
    assert.match(xml, /<image:image>\s*<image:loc>https:\/\/example\.test\/media\/1\/cover\.jpg<\/image:loc>/);
  });
});

describe("seo: injectSeoIntoStandalone (semi-wrapped)", () => {
  const baseHtml = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>Titolo scritto a mano</title>
  <meta name="description" content="Descrizione scritta a mano">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <p>Contenuto</p>
</body>
</html>`;

  test("senza </head>: html invariato", () => {
    const out = injectSeoIntoStandalone("<html><body>no head</body></html>", { meta_title: "X" });
    assert.equal(out, "<html><body>no head</body></html>");
  });

  test("campi vuoti: html invariato (override non distruttivo)", () => {
    const out = injectSeoIntoStandalone(baseHtml, {});
    assert.equal(out, baseHtml);
    const out2 = injectSeoIntoStandalone(baseHtml, { meta_title: "", meta_description: "", noindex: false });
    assert.equal(out2, baseHtml);
  });

  test("meta_title valorizzato: sostituisce il <title> esistente", () => {
    const out = injectSeoIntoStandalone(baseHtml, { meta_title: "Nuovo titolo SEO" });
    assert.match(out, /<title>Nuovo titolo SEO<\/title>/);
    assert.doesNotMatch(out, /Titolo scritto a mano/);
  });

  test("meta_title valorizzato senza <title>: lo inserisce prima di </head>", () => {
    const out = injectSeoIntoStandalone("<html><head><meta charset=\"UTF-8\"></head><body>x</body></html>", { meta_title: "T" });
    assert.match(out, /<title>T<\/title>/);
    assert.ok(out.indexOf("<title>T</title>") < out.indexOf("</head>"), "title prima di </head>");
  });

  test("meta_description: sostituisce quello esistente", () => {
    const out = injectSeoIntoStandalone(baseHtml, { meta_description: "Nuova descrizione" });
    assert.match(out, /<meta name="description" content="Nuova descrizione">/);
    assert.doesNotMatch(out, /Descrizione scritta a mano/);
  });

  test("noindex: aggiunge/sostituisce meta robots", () => {
    const out = injectSeoIntoStandalone(baseHtml, { noindex: true });
    assert.match(out, /<meta name="robots" content="noindex,follow">/);
    const out2 = injectSeoIntoStandalone(baseHtml.replace("</head>", '<meta name="robots" content="noindex">\n</head>'), { noindex: true });
    assert.equal((out2.match(/name="robots"/g) || []).length, 1, "un solo meta robots, sostituito non duplicato");
  });

  test("canonical + og:image + brand: inseriti, og:url = canonical", () => {
    const out = injectSeoIntoStandalone(baseHtml, {
      canonicalUrl: "https://example.test/articolo", ogImage: "https://example.test/media/1/copertina.jpg", brandName: "Esempio",
    });
    assert.match(out, /<link rel="canonical" href="https:\/\/example\.test\/articolo">/);
    assert.match(out, /<meta property="og:url" content="https:\/\/example\.test\/articolo">/);
    assert.match(out, /<meta property="og:image" content="https:\/\/example\.test\/media\/1\/copertina\.jpg">/);
    assert.match(out, /<meta property="og:site_name" content="Esempio">/);
    assert.match(out, /<meta name="twitter:card" content="summary_large_image">/);
  });

  test("meta_keywords valorizzato: emesso (campo prima ignorato ovunque)", () => {
    const out = injectSeoIntoStandalone(baseHtml, { meta_keywords: "cms, seo" });
    assert.match(out, /<meta name="keywords" content="cms, seo">/);
  });

  test("escaping: valori con virgolette e < non rompono gli attributi", () => {
    const out = injectSeoIntoStandalone(baseHtml, { meta_description: 'Descrizione "quoted" <b>x</b>' });
    assert.match(out, /content="Descrizione &quot;quoted&quot; &lt;b&gt;x&lt;\/b&gt;"/);
    assert.doesNotMatch(out, /<b>x<\/b>/);
  });

  test("JSON-LD: non iniettato se l'HTML ne ha già uno", () => {
    const withLd = baseHtml.replace("</head>", '<script type="application/ld+json">{"@type":"Article"}</script>\n</head>');
    const out = injectSeoIntoStandalone(withLd, { webpageJsonLd: "{\"@type\":\"WebPage\"}" });
    assert.match(out, /"@type":"Article"/);
    assert.doesNotMatch(out, /"@type":"WebPage"/);
  });

  test("JSON-LD: iniettato solo se assente (webpage + website in homepage)", () => {
    const out = injectSeoIntoStandalone(baseHtml, {
      meta_title: "Titolo",
      webpageJsonLd: "{\"@type\":\"WebPage\"}",
      websiteJsonLd: "{\"@type\":\"WebSite\"}",
    });
    assert.match(out, /"@type":"WebPage"/);
    assert.match(out, /"@type":"WebSite"/);
    assert.equal((out.match(/application\/ld\+json/g) || []).length, 2);
  });

  test("JSON-LD da solo (senza campi contenutistici): html invariato", () => {
    const out = injectSeoIntoStandalone(baseHtml, { webpageJsonLd: "{\"@type\":\"WebPage\"}" });
    assert.doesNotMatch(out, /WebPage/);
    assert.equal(out, baseHtml);
  });

  test("twitter handle: normalizzato con @", () => {
    const out = injectSeoIntoStandalone(baseHtml, { twitterHandle: "esempio" });
    assert.match(out, /<meta name="twitter:site" content="@esempio">/);
  });
});
