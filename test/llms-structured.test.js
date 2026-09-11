import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { getSiteSeoConfig, setSiteSeoConfig } from "../src/services/site-seo.js";
import {
  getPublishedPagesForSitemap, buildLlmsTxt, groupPagesForLlms,
  buildBreadcrumbJsonLd, buildFaqJsonLd, serializeJsonLd,
  injectSeoIntoStandalone,
} from "../src/services/seo.js";

describe("llms.txt: builder e raggruppamento", () => {
  test("buildLlmsTxt: formato H1 + blockquote + sezioni", () => {
    const txt = buildLlmsTxt({
      siteName: "Esempio Srl",
      description: "Azienda di esempio a Milano",
      baseUrl: "https://example.test",
      sections: [
        { title: "Home", items: [{ title: "Home", url: "https://example.test/", description: "" }] },
        { title: "Servizi", items: [{ title: "Web", url: "https://example.test/servizi/web", description: "Siti" }] },
      ],
    });
    assert.match(txt, /^# Esempio Srl\n/);
    assert.match(txt, /^> Azienda di esempio a Milano$/m);
    assert.match(txt, /## Servizi/);
    assert.match(txt, /- \[Web\]\(https:\/\/example\.test\/servizi\/web\): Siti/);
  });

  test("buildLlmsTxt: input mancanti non lanciano", () => {
    const txt = buildLlmsTxt({ siteName: "X", description: null, baseUrl: "https://x.test" });
    assert.match(txt, /^# X\n/);
  });

  test("buildLlmsTxt: parentesi quadre nell'URL/titolo neutralizzate", () => {
    const txt = buildLlmsTxt({
      siteName: "S",
      description: "d",
      baseUrl: "https://x.test",
      sections: [{ title: "T", items: [{ title: "A [B] C", url: "https://x.test/a", description: "" }] }],
    });
    assert.match(txt, /- \[A \(B\) C\]\(https:\/\/x\.test\/a\)/);
  });

  test("groupPagesForLlms: raggruppa per prefisso, home per prima", () => {
    const sections = groupPagesForLlms([
      { url_path: "/", title: "Home", meta_title: "Homepage", meta_description: "" },
      { url_path: "/servizi/web", title: "Web", meta_title: null, meta_description: "" },
      { url_path: "/blog/post-1", title: "Post 1", meta_description: "x" },
    ], "https://example.test");
    const titles = sections.map(s => s.title);
    assert.equal(titles[0], "Home");
    assert.ok(titles.includes("Servizi"));
    assert.ok(titles.includes("Blog"));
    const servizi = sections.find(s => s.title === "Servizi");
    assert.equal(servizi.items[0].url, "https://example.test/servizi/web");
  });
});

describe("structured data: builder", () => {
  test("buildBreadcrumbJsonLd: genera posizioni da path", () => {
    const bc = buildBreadcrumbJsonLd({ baseUrl: "https://example.test", urlPath: "/servizi/web", pageTitle: "Servizi Web" });
    assert.equal(bc["@type"], "BreadcrumbList");
    assert.equal(bc.itemListElement.length, 3);
    assert.equal(bc.itemListElement[0].name, "Home");
    assert.equal(bc.itemListElement[2].name, "Servizi Web");
    assert.equal(bc.itemListElement[1].item, "https://example.test/servizi");
  });

  test("buildFaqJsonLd: array vuoto/null → null", () => {
    assert.equal(buildFaqJsonLd([]), null);
    assert.equal(buildFaqJsonLd(null), null);
  });

  test("buildFaqJsonLd: mappa Q/A in Question/acceptedAnswer", () => {
    const faq = buildFaqJsonLd([{ question: "Q1?", answer: "A1" }]);
    assert.equal(faq["@type"], "FAQPage");
    assert.equal(faq.mainEntity[0]["@type"], "Question");
    assert.equal(faq.mainEntity[0].acceptedAnswer.text, "A1");
  });

  test("serializeJsonLd: '<' escapato per non chiudere lo script", () => {
    const s = serializeJsonLd({ "@type": "Thing", name: "</script><script>alert(1)</script>" });
    assert.doesNotMatch(s, /<\/script>/);
  });
});

describe("structured data: iniezione manuale prevale", () => {
  const baseHtml = `<!DOCTYPE html><html><head><title>T</title></head><body>x</body></html>`;

  test("manualSchemaJsonLd viene iniettato quando presente", () => {
    const out = injectSeoIntoStandalone(baseHtml, {
      meta_title: "T",
      manualSchemaJsonLd: JSON.stringify({ "@type": "FAQPage" }),
    });
    assert.match(out, /"@type":"FAQPage"/);
  });

  test("non iniettato se l'HTML ha già un JSON-LD", () => {
    const withLd = baseHtml.replace("</head>", '<script type="application/ld+json">{"@type":"X"}</script></head>');
    const out = injectSeoIntoStandalone(withLd, {
      meta_title: "T",
      manualSchemaJsonLd: JSON.stringify({ "@type": "FAQPage" }),
    });
    assert.doesNotMatch(out, /FAQPage/);
  });
});

describe("seo: llmsDescription per-sito + colonne structured data", () => {
  let site;
  before(async () => { site = await createTestSite("Structured Test"); });
  after(async () => { await closeDb(); });

  test("llmsDescription: round-trip su settings", async () => {
    await setSiteSeoConfig(site.id, { llmsDescription: "Descrizione AI del sito" });
    const c = await getSiteSeoConfig(site.id);
    assert.equal(c.llmsDescription, "Descrizione AI del sito");
  });

  test("getPublishedPagesForSitemap: include title/meta per llms.txt", async () => {
    await query(
      "INSERT INTO pages (site_id, url_path, title, published) VALUES ($1, '/pagina', 'Titolo Pagina', true)",
      [site.id]
    );
    const pages = await getPublishedPagesForSitemap(site.id);
    const p = pages.find(x => x.url_path === "/pagina");
    assert.ok(p);
    assert.equal(p.title, "Titolo Pagina");
  });

  test("page_seo ha le colonne schema_type/schema_json", async () => {
    const page = (await query(
      "INSERT INTO pages (site_id, url_path, title, published) VALUES ($1, '/schema', 'Schema', true) RETURNING id",
      [site.id]
    )).rows[0];
    await query(
      "INSERT INTO page_seo (page_id, schema_type, schema_json) VALUES ($1, $2, $3::jsonb)",
      [page.id, "FAQPage", JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage" })]
    );
    const row = (await query("SELECT schema_type, schema_json FROM page_seo WHERE page_id = $1", [page.id])).rows[0];
    assert.equal(row.schema_type, "FAQPage");
    assert.equal(row.schema_json["@type"], "FAQPage");
  });
});
