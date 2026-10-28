import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { expandSnippets, expandPageContent } from "../src/services/page-renderer.js";

// Segnalato dall'utente: una pagina con un iframe GoHighLevel incollato a
// mano (<iframe src="https://api.leadconnectorhq.com/widget/form/...">) non
// riceveva gli UTM della pagina.
//
// Tentativo iniziale (poi corretto): un nostro script che riscriveva
// `iframe.src` per forzarne il ricaricamento con gli UTM in query string.
// Si è rivelato ridondante E probabilmente controproducente: form_embed.js
// di GHL legge GIÀ DA SOLO gli UTM da location.search della pagina che
// ospita l'iframe e li inoltra al form via postMessage al caricamento
// (verificato leggendo il sorgente dello script ufficiale GHL) — forzare un
// reload dell'iframe DOPO quell'handshake iniziale lo scollega, perché GHL
// non ripete l'handshake su un semplice reload. Rimosso.
//
// Il problema REALE (che questo fix risolve): un CTA interno
// (<a href="/pagina-successiva">) in un funnel a più pagine (landing ->
// contatto -> iframe) azzera gli UTM alla prima navigazione — quando il
// visitatore arriva sulla pagina con l'iframe, il SUO location.search è
// già vuoto, e form_embed.js (per quanto corretto) non ha nulla da
// leggere. expandPageContent() riporta avanti gli UTM sui link interni ad
// ogni hop, senza toccare l'iframe in alcun modo.
describe("expandPageContent: riporta avanti gli UTM sui link interni (mai sull'iframe)", () => {
  let site;

  after(async () => { await closeDb(); });

  test("link interni: script di forward sempre presente, anche senza iframe/form", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<a href="/contatti">Contattaci</a>`;
    const out = await expandPageContent(site.id, html);
    assert.ok(out.includes('document.querySelectorAll("a[href]")'), "lo script di forward sui link deve essere sempre presente");
    assert.ok(out.includes("utm_content"), "lo script deve coprire anche utm_content");
  });

  test("pagina con iframe GHL: NESSUNO script tocca l'iframe (solo il forward sui link)", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<div><iframe src="https://api.leadconnectorhq.com/widget/form/abc123" id="x"></iframe></div>`;
    const out = await expandPageContent(site.id, html);
    assert.ok(!out.includes('iframe[src*='), "non deve esistere alcuno script che modifica iframe.src — GHL lo fa già da solo");
    assert.ok(!out.includes("utmForwarded"), "nessun residuo del vecchio meccanismo rimosso");
    // L'iframe originale deve restare byte-per-byte invariato.
    assert.ok(out.includes('<iframe src="https://api.leadconnectorhq.com/widget/form/abc123" id="x"></iframe>'));
  });

  test("expandSnippets() (usata da newsletter.js) NON include lo script di forward link", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<iframe src="https://api.leadconnectorhq.com/widget/form/abc123"></iframe><a href="/contatti">Vai</a>`;
    const out = await expandSnippets(site.id, html);
    // Html senza {{form:}}/{{snippet:}}/ecc.: expandSnippets deve lasciarlo
    // invariato (nessuna espansione da fare), prova diretta che non abbia
    // appeso nulla in coda.
    assert.equal(out, html, "senza placeholder da espandere, expandSnippets deve restituire l'html invariato");
    assert.ok(!out.includes('document.querySelectorAll("a[href]")'), "expandSnippets non deve iniettare lo script di forward link");
  });
});
