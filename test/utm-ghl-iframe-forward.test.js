import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { expandSnippets, expandPageContent } from "../src/services/page-renderer.js";

// Segnalato dall'utente: una pagina con un iframe GoHighLevel incollato a
// mano (<iframe src="https://api.leadconnectorhq.com/widget/form/...">) non
// riceveva gli UTM della pagina — a differenza dei form nativi {{form:slug}},
// un iframe cross-origin non ha accesso all'URL della pagina che lo ospita,
// quindi il meccanismo già esistente (hidden input su un <form> nativo) non
// può funzionare per un iframe. expandPageContent() chiude il gap con due
// script generali (non specifici per nessun sito): uno appende gli UTM al
// `src` di qualunque iframe GHL trovato in pagina, l'altro li riporta avanti
// sui link interni perché non si perdano al primo hop di un funnel
// multi-pagina (landing -> contatto -> iframe).
describe("expandPageContent: forward UTM verso iframe GHL + link interni", () => {
  let site;

  after(async () => { await closeDb(); });

  test("pagina con iframe GHL: script di forward iframe presente", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<div><iframe src="https://api.leadconnectorhq.com/widget/form/abc123" id="x"></iframe></div>`;
    const out = await expandPageContent(site.id, html);
    assert.ok(out.includes('iframe[src*="leadconnectorhq.com"]'), "deve contenere lo script di forward verso iframe GHL");
    assert.ok(out.includes("utm_content"), "lo script deve coprire anche utm_content");
  });

  test("pagina SENZA iframe GHL: nessuno script iframe iniettato (niente peso morto)", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<div><p>Pagina senza alcun iframe</p></div>`;
    const out = await expandPageContent(site.id, html);
    assert.ok(!out.includes("leadconnectorhq.com"), "nessun riferimento GHL se non c'è un iframe GHL in pagina");
  });

  test("link interni: script di forward sempre presente, anche senza iframe/form", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<a href="/contatti">Contattaci</a>`;
    const out = await expandPageContent(site.id, html);
    assert.ok(out.includes('document.querySelectorAll("a[href]")'), "lo script di forward sui link deve essere sempre presente");
  });

  test("msgsndr.com (secondo dominio GHL) viene riconosciuto allo stesso modo di leadconnectorhq.com", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<iframe src="https://link.msgsndr.com/widget/form/xyz"></iframe>`;
    const out = await expandPageContent(site.id, html);
    assert.ok(out.includes('iframe[src*="msgsndr.com"]'), "deve riconoscere anche il dominio msgsndr.com");
  });

  test("expandSnippets() (usata da newsletter.js) NON include nessuno dei due script", async () => {
    site = site || await createTestSite("UTM GHL Iframe Test");
    const html = `<iframe src="https://api.leadconnectorhq.com/widget/form/abc123"></iframe><a href="/contatti">Vai</a>`;
    const out = await expandSnippets(site.id, html);
    // Html senza {{form:}}/{{snippet:}}/ecc.: expandSnippets deve lasciarlo
    // invariato (nessuna espansione da fare), prova diretta che non abbia
    // appeso nulla in coda.
    assert.equal(out, html, "senza placeholder da espandere, expandSnippets deve restituire l'html invariato");
    assert.ok(!out.includes('iframe[src*="leadconnectorhq.com"]'), "expandSnippets non deve iniettare lo script di forward iframe");
    assert.ok(!out.includes('document.querySelectorAll("a[href]")'), "expandSnippets non deve iniettare lo script di forward link");
  });
});
