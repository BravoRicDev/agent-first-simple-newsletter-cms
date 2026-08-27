import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { getSiteTrackingConfig, getSiteTrackingConfigMasked, setSiteTrackingConfig, sendMetaCapiEvent, injectTrackingIntoStandalone } from "../src/services/tracking.js";

describe("tracking: config per sito, mascheramento token, Conversions API", () => {
  let site;

  before(async () => { site = await createTestSite("Tracking Test"); });
  after(async () => { await closeDb(); });

  test("sito senza config: hasAnyTracking false, nessun campo popolato", async () => {
    const c = await getSiteTrackingConfig(site.id);
    assert.equal(c.hasAnyTracking, false);
    assert.equal(c.ga4Id, "");
  });

  test("dopo aver impostato un ID, i testi del banner tornano ai default", async () => {
    await setSiteTrackingConfig(site.id, { ga4Id: "G-ABC" });
    const c = await getSiteTrackingConfig(site.id);
    assert.equal(c.hasAnyTracking, true);
    assert.match(c.consentBannerText, /cookie/i);
    assert.ok(c.consentAcceptLabel.length > 0);
  });

  test("i testi del banner personalizzati sovrascrivono i default", async () => {
    await setSiteTrackingConfig(site.id, { consentBannerText: "Testo custom", consentAcceptLabel: "Vai" });
    const c = await getSiteTrackingConfig(site.id);
    assert.equal(c.consentBannerText, "Testo custom");
    assert.equal(c.consentAcceptLabel, "Vai");
  });

  test("il token CAPI non è mai restituito in chiaro dalla versione mascherata", async () => {
    await setSiteTrackingConfig(site.id, { metaCapiToken: "SEGRETO_XYZ" });
    const masked = await getSiteTrackingConfigMasked(site.id);
    assert.notEqual(masked.metaCapiToken, "SEGRETO_XYZ");
    assert.equal(masked.metaCapiToken, "••••••••");

    const full = await getSiteTrackingConfig(site.id);
    assert.equal(full.metaCapiToken, "SEGRETO_XYZ", "la versione non mascherata deve comunque avere il valore reale, per l'invio server-side");
  });

  test("sendMetaCapiEvent: senza consenso non tenta nemmeno la chiamata di rete", async () => {
    let called = false;
    const realFetch = global.fetch;
    global.fetch = async () => { called = true; return { ok: true, text: async () => "" }; };
    try {
      const result = await sendMetaCapiEvent(site.id, "Lead", { email: "x@example.test", consentGranted: false });
      assert.equal(result.sent, false);
      assert.equal(result.reason, "no_consent");
      assert.equal(called, false);
    } finally {
      global.fetch = realFetch;
    }
  });

  test("sendMetaCapiEvent: con consenso e config, invia con email hashata SHA-256", async () => {
    await setSiteTrackingConfig(site.id, { metaPixelId: "999", metaCapiToken: "TOK" });
    const realFetch = global.fetch;
    let capturedBody;
    global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, text: async () => "" }; };
    try {
      const result = await sendMetaCapiEvent(site.id, "Lead", { email: "Mario@Example.TEST", consentGranted: true });
      assert.equal(result.sent, true);
      const crypto = await import("crypto");
      const expectedHash = crypto.createHash("sha256").update("mario@example.test").digest("hex");
      assert.equal(capturedBody.data[0].user_data.em[0], expectedHash);
      assert.equal(capturedBody.data[0].event_name, "Lead");
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe("tracking: injectTrackingIntoStandalone (semi-wrapped)", () => {
  const baseHtml = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>Articolo</title>
</head>
<body>
  <p>Contenuto</p>
</body>
</html>`;

  const blocks = {
    head: '<script>window.dataLayer=[];</script>',
    body: '<div id="cms-consent-banner">Banner</div><script>consent js</script>',
  };

  test("senza blocchi: html invariato", () => {
    const out = injectTrackingIntoStandalone(baseHtml, { head: "", body: "" });
    assert.equal(out, baseHtml);
    assert.equal(injectTrackingIntoStandalone(baseHtml, {}), baseHtml);
  });

  test("head iniettato prima di </head>, body prima di </body>", () => {
    const out = injectTrackingIntoStandalone(baseHtml, blocks);
    assert.ok(out.indexOf(blocks.head) < out.indexOf("</head>"), "head prima di </head>");
    assert.ok(out.indexOf(blocks.body) < out.indexOf("</body>"), "body prima di </body>");
    assert.ok(out.indexOf("</head>") < out.indexOf(blocks.body), "body dopo </head>");
  });

  test("senza </body>: body prima di </html>", () => {
    const noBody = baseHtml.replace("</body>", "");
    const out = injectTrackingIntoStandalone(noBody, blocks);
    assert.ok(out.indexOf(blocks.body) < out.indexOf("</html>"), "body prima di </html>");
  });

  test("senza </body> e </html>: body in coda al documento", () => {
    const bare = "<html><head></head><p>x</p>";
    const out = injectTrackingIntoStandalone(bare, blocks);
    assert.ok(out.endsWith(blocks.body), "body in coda");
    assert.ok(out.includes(blocks.head), "head comunque iniettato");
  });

  test("senza </head>: blocco head scartato ma body iniettato", () => {
    const noHead = "<html><body><p>x</p></body></html>";
    const out = injectTrackingIntoStandalone(noHead, blocks);
    assert.doesNotMatch(out, /window\.dataLayer/);
    assert.match(out, /cms-consent-banner/);
  });

  test("input non stringa: ritorna invariato", () => {
    assert.equal(injectTrackingIntoStandalone(null, blocks), null);
    assert.equal(injectTrackingIntoStandalone("", blocks), "");
  });
});
