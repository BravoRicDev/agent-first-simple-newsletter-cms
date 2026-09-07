import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import ejs from "ejs";
import path from "path";
import { fileURLToPath } from "url";
import { createTestSite, closeDb } from "./helpers.js";
import { getSiteTrackingConfig, setSiteTrackingConfig } from "../src/services/tracking.js";

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../views");

// ─────────────────────────────────────────────────────────────────────────
// Consent — provider "library" (libreria condivisa nel repo):
//  - asset serviti staticamente da /consent/* (nessuna dipendenza da media/)
//  - testi/posizione/lingua per-sito iniettabili (XSS-safe via _jsonScript)
//  - markup banner nativo presente ma nascosto, con fallback (funzione
//    __cmsNativeConsentShow / __cmsConsentFallbackNative)
//  - modalità native ed external restano funzionanti (retrocompatibilità)
// ─────────────────────────────────────────────────────────────────────────

describe("consent: provider library per-sito (asset repo + fallback nativo)", () => {
  let site;

  before(async () => { site = await createTestSite("Consent Lib Test"); });

  after(async () => { await closeDb(); });

  function renderBody(locals) {
    return ejs.renderFile(path.join(VIEWS, "partials", "tracking-body.ejs"), {
      app: { name: "CMS" },
      hasAnyTracking: true,
      trackPageview: true,
      consentBannerText: "Banner nativo",
      consentAcceptLabel: "Accetta",
      consentRejectLabel: "Rifiuta",
      consentPrivacyUrl: "/privacy",
      consentProvider: "native",
      ...locals,
    });
  }

  test("provider library → config usa gli asset condivisi del repo (/consent/*)", async () => {
    await setSiteTrackingConfig(site.id, {
      ga4Id: "G-LIB", metaPixelId: "12345",
      consentProvider: "library",
      consentTitle: "Privacy & Cookie",
      consentPosition: "bottom right",
      consentLanguage: "it",
    });
    const c = await getSiteTrackingConfig(site.id);
    assert.equal(c.consentProvider, "library");
    assert.equal(c.consentLibUrl, "/consent/consent.js");
    assert.equal(c.consentLibCssUrl, "/consent/consent.css");
    assert.equal(c.consentScriptUrl, "/consent/bridge.js");
    assert.ok(c.hasAnyTracking);
  });

  test("render modalità library: carica lib+bridge dal repo, banner nativo nascosto ma presente", async () => {
    const html = await renderBody({
      consentProvider: "library",
      consentLibUrl: "/consent/consent.js",
      consentLibCssUrl: "/consent/consent.css",
      consentScriptUrl: "/consent/bridge.js",
      consentPosition: "bottom right", consentLanguage: "it", consentRevision: "1",
      consentTitle: "Privacy & Cookie", consentDescription: "Desc",
      consentAcceptAllLabel: "Accetta tutto", consentRejectLabelLib: "Rifiuta",
      consentPreferencesLabel: "Preferenze",
    });
    assert.match(html, /\/consent\/consent\.js/, "carica la lib dal repo (non da media)");
    assert.match(html, /\/consent\/bridge\.js/, "carica il bridge dal repo");
    assert.match(html, /__cmsConsentConfig/, "config per-sito iniettata");
    assert.match(html, /cms-consent-banner/, "markup banner nativo presente (fallback)");
    assert.match(html, /__cmsConsentFallbackNative/, "fallback nativo esposto");
    // Il banner nativo NON deve essere autogestito in modalità library
    // (cioè lo script nativo non deve mostrarlo da solo): il blocco
    // "if provider === 'native'" è presente ma condizionato.
    assert.match(html, /=== 'native'/, "auto-native è condizionato al provider");
  });

  test("render modalità native: banner attivo, nessun riferimento alla lib", async () => {
    const html = await renderBody({ consentProvider: "native" });
    assert.match(html, /cms-consent-banner/, "banner presente");
    assert.doesNotMatch(html, /consent\.js/, "niente libreria esterna in modalità native");
  });

  test("render diretto con consentProvider='external' (sinonimo difensivo, non più raggiungibile da UI/getSiteTrackingConfig)", async () => {
    // getSiteTrackingConfig normalizza sempre external → library (vedi test
    // dedicato in tracking.test.js): questo test copre solo il fallback
    // difensivo nel template, per chi chiamasse renderBody direttamente
    // con un valore "external" residuo salvato in passato.
    const html = await renderBody({
      consentProvider: "external",
      consentLibUrl: "/media/22/consent/consent.js",
      consentLibCssUrl: "/media/22/consent/consent.css",
      consentScriptUrl: "/media/22/consent/bridge.js",
    });
    assert.match(html, /\/media\/22\/consent\/consent\.js/, "il template tratta ancora 'external' come sinonimo di 'library'");
  });

  test("re-apply consenso a ogni page load in TUTTE le modalità (fix pixel morto al ritorno)", async () => {
    // In native, external e library il blocco di re-apply dai cookies deve
    // esserci SEMPRE: il CMS non deve dipendere dal bridge esterno per
    // riapplicare il consenso (i bridge vecchi fanno return prematuro).
    for (const provider of ["native", "external", "library"]) {
      const html = await renderBody({
        consentProvider: provider,
        consentLibUrl: provider === "library" ? "/consent/consent.js" : "/media/22/consent/consent.js",
        consentLibCssUrl: provider === "library" ? "/consent/consent.css" : "/media/22/consent/consent.css",
        consentScriptUrl: provider === "library" ? "/consent/bridge.js" : "/media/22/consent/bridge.js",
      });
      assert.match(html, /storedAnalytics !== null \|\| storedMarketing !== null/, `${provider}: re-apply dai cookies presente`);
      assert.match(html, /applyConsent\(storedAnalytics === '1', storedMarketing === '1'\)/, `${provider}: riapplica il consenso salvato`);
      assert.match(html, /__cmsApplyConsent/, `${provider}: helper condiviso esposto globalmente`);
      assert.match(html, /_fbqTimer/, `${provider}: polling anti-pixel-in-ritardo presente`);
    }
  });

  test("blocco Lead client-side: presente solo se leadEventName+leadPages/override configurati", async () => {
    const senza = await renderBody({ consentProvider: "native" });
    assert.doesNotMatch(senza, /cms_lead_fired_/, "senza config Lead il blocco non c'è (nessuna regressione)");

    const con = await renderBody({
      consentProvider: "external",
      consentLibUrl: "/media/22/consent/consent.js",
      consentScriptUrl: "/media/22/consent/bridge.js",
      leadEventName: "Lead",
      leadPages: "/1/thank-you, /grazie",
      leadOverride: null,
    });
    assert.match(con, /cms_lead_fired_/, "blocco Lead presente");
    assert.match(con, /var EVENT_NAME = "Lead"/, "nome evento iniettato");
    assert.match(con, /\/1\/thank-you/, "pagine lead iniettate");
    assert.match(con, /cms:marketing-granted/, "agganciato al consenso marketing");
    assert.match(con, /_leadTimer/, "retry fbq in ritardo presente");

    const overrideFalse = await renderBody({
      consentProvider: "library",
      consentLibUrl: "/consent/consent.js",
      consentScriptUrl: "/consent/bridge.js",
      leadEventName: "Lead",
      leadPages: "",
      leadOverride: true,
    });
    assert.match(overrideFalse, /LEAD_OVERRIDE = true/, "override true forzato anche fuori leadPages");
  });

  test("XSS-safe: un testo contenente </script> non rompe il blocco", async () => {
    const html = await renderBody({
      consentProvider: "library",
      consentLibUrl: "/consent/consent.js",
      consentScriptUrl: "/consent/bridge.js",
      consentTitle: "</script><script>alert(1)</script>",
      consentDescription: "x</script><script>y",
    });
    assert.ok(!html.includes("</script><script>alert(1)"), "la chiusura del tag deve essere neutra");
  });
});