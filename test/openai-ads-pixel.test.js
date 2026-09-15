import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import { createTestSite, closeDb } from "./helpers.js";
import {
  getSiteTrackingConfig, getSiteTrackingConfigMasked, setSiteTrackingConfig,
  getEffectiveTrackingConfig, sendOpenAiAdsEvent,
} from "../src/services/tracking.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, "../views");

function render(partial, locals) {
  return ejs.renderFile(path.join(VIEWS, "partials", partial), { layout: false, cache: false, ...locals });
}

describe("OpenAI Ads: pixel lato client (SDK ufficiale)", () => {
  test("tracking-head: init del pixel + consenso negato + SDK ufficiale", async () => {
    const html = await render("tracking-head.ejs", {
      hasAnyTracking: true, openaiAdsPixelId: "px_abc", pixelEnabled: true,
    });
    assert.match(html, /bzrcdn\.openai\.com\/sdk\/oaiq\.min\.js/);
    assert.match(html, /\['consent', false\]/);
    assert.match(html, /\['init', \{ pixelId: "px_abc" \}\]/);
  });

  test("tracking-head: SDK url personalizzabile per-sito", async () => {
    const html = await render("tracking-head.ejs", {
      hasAnyTracking: true, openaiAdsPixelId: "px_abc", pixelEnabled: true,
      openaiAdsSdkUrl: "https://cdn.example.test/sdk/oaiq.js",
    });
    assert.match(html, /https:\/\/cdn\.example\.test\/sdk\/oaiq\.js/);
  });

  test("tracking-head: pixelEnabled=false → nessun pixel OpenAI", async () => {
    const html = await render("tracking-head.ejs", {
      hasAnyTracking: true, openaiAdsPixelId: "px_abc", pixelEnabled: false,
    });
    assert.doesNotMatch(html, /oaiq/);
  });

  test("tracking-body: consenso marketing → consent true + page_viewed", async () => {
    const html = await render("tracking-body.ejs", {
      hasAnyTracking: true, consentProvider: "native", openaiAdsPixelId: "px_abc",
      pixelEnabled: true, trackPageview: true,
    });
    assert.match(html, /oaiqCall\('consent', true\)/);
    assert.match(html, /oaiqCall\('measure', 'page_viewed', \{ type: 'contents' \}\)/);
  });

  test("tracking-body: lead su pagine di conversione → lead_created/customer_action", async () => {
    const html = await render("tracking-body.ejs", {
      hasAnyTracking: true, consentProvider: "native", openaiAdsPixelId: "px_abc",
      pixelEnabled: true, trackPageview: true, leadPages: "/grazie",
    });
    assert.match(html, /oaiqCall\('measure', 'lead_created', \{ type: 'customer_action' \}\)/);
  });

  test("tracking-body: CompleteRegistration Override → registration_completed", async () => {
    const html = await render("tracking-body.ejs", {
      hasAnyTracking: true, consentProvider: "native", openaiAdsPixelId: "px_abc",
      pixelEnabled: true, completeRegistrationOverride: true,
    });
    assert.match(html, /oaiqCall\('measure', 'registration_completed', \{ type: 'customer_action' \}\)/);
  });

  test("tracking-body: advanced matching OFF → nessuna API identify", async () => {
    const html = await render("tracking-body.ejs", {
      hasAnyTracking: true, consentProvider: "native", openaiAdsPixelId: "px_abc",
      pixelEnabled: true, openaiAdsAdvancedMatching: "",
    });
    assert.doesNotMatch(html, /__cmsOpenAiIdentify/);
  });

  test("tracking-body: advanced matching ON → API identify + auto-identify opzionale", async () => {
    const html = await render("tracking-body.ejs", {
      hasAnyTracking: true, consentProvider: "native", openaiAdsPixelId: "px_abc",
      pixelEnabled: true, openaiAdsAdvancedMatching: "1", openaiAdsAutoIdentify: "1",
    });
    assert.match(html, /window\.__cmsOpenAiIdentify = function/);
    assert.match(html, /email_sha256/);
    assert.match(html, /phone_number_sha256/);
    assert.match(html, /submit/);
  });
});

describe("OpenAI Ads: config, server-side e advanced matching", () => {
  let site;
  before(async () => { site = await createTestSite("OpenAI Ads Test"); });
  after(async () => { await closeDb(); });

  test("hasAnyTracking=true anche col solo pixel OpenAI", async () => {
    await setSiteTrackingConfig(site.id, { openaiAdsPixelId: "px_only" });
    const c = await getSiteTrackingConfig(site.id);
    assert.equal(c.hasAnyTracking, true);
  });

  test("pixelEnabled default true col solo pixel OpenAI", async () => {
    const eff = await getEffectiveTrackingConfig(site.id, null);
    assert.equal(eff.pixelEnabled, true);
    assert.equal(eff.openaiAdsPixelId, "px_only");
  });

  test("openaiAdsSdkUrl: default dall'installazione", async () => {
    const c = await getSiteTrackingConfig(site.id);
    assert.match(c.openaiAdsSdkUrl, /oaiq\.min\.js$/);
  });

  test("masking della API key OpenAI", async () => {
    await setSiteTrackingConfig(site.id, { openaiAdsApiKey: "sk-secret" });
    const c = await getSiteTrackingConfigMasked(site.id);
    assert.equal(c.openaiAdsApiKey, "••••••••");
  });

  test("sendOpenAiAdsEvent: no_consent / not_configured (fail-safe)", async () => {
    const bare = await createTestSite("OpenAI Bare");
    const a = await sendOpenAiAdsEvent(bare.id, "Lead", { consentGranted: false, email: "a@b.test" });
    assert.deepEqual([a.sent, a.reason], [false, "no_consent"]);
    const b = await sendOpenAiAdsEvent(bare.id, "Lead", { consentGranted: true, email: "a@b.test" });
    assert.deepEqual([b.sent, b.reason], [false, "not_configured"]);
  });

  test("sendOpenAiAdsEvent: advanced matching ON/OFF controlla i campi hashed", async () => {
    const s = await createTestSite("OpenAI AM");
    await setSiteTrackingConfig(s.id, { openaiAdsPixelId: "px_am", openaiAdsApiKey: "sk-x" });

    const captured = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { captured.push({ url: String(url), body: opts.body }); return { ok: true, status: 200, text: async () => "" }; };
    try {
      // OFF (default): nessun hash nel payload
      await sendOpenAiAdsEvent(s.id, "Lead", { consentGranted: true, email: "mario@example.test", phone: "+39 333 1234567" });
      assert.equal(captured.length, 1);
      assert.doesNotMatch(captured[0].body, /email_sha256/);
      assert.match(captured[0].body, /lead_created/);

      // ON: email_sha256 + phone_number_sha256 presenti
      await setSiteTrackingConfig(s.id, { openaiAdsAdvancedMatching: "1" });
      await sendOpenAiAdsEvent(s.id, "Lead", { consentGranted: true, email: "mario@example.test", phone: "+39 333 1234567" });
      assert.equal(captured.length, 2);
      assert.match(captured[1].body, /email_sha256/);
      assert.match(captured[1].body, /phone_number_sha256/);
      // nessuna PII in chiaro
      assert.doesNotMatch(captured[1].body, /mario@example\.test/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
