import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "./helpers.js";
import { getSiteTrackingConfigMasked, setSiteTrackingConfig, sendOpenAiAdsEvent } from "../src/services/tracking.js";

describe("tracking: OpenAI Ads server-side", () => {
  after(async () => { await closeDb(); });

  test("sendOpenAiAdsEvent: no_consent senza consenso (fail-safe)", async () => {
    const r = await sendOpenAiAdsEvent(1, "Lead", { consentGranted: false, email: "a@b.test" });
    assert.equal(r.sent, false);
    assert.equal(r.reason, "no_consent");
  });

  test("sendOpenAiAdsEvent: not_configured senza pixel/token", async () => {
    const r = await sendOpenAiAdsEvent(999999, "Lead", { consentGranted: true, email: "a@b.test" });
    assert.equal(r.sent, false);
    assert.equal(r.reason, "not_configured");
  });

  test("getSiteTrackingConfigMasked: maschera la API key OpenAI", async () => {
    await setSiteTrackingConfig(1, { openaiAdsPixelId: "px_1", openaiAdsApiKey: "sk-secret" });
    const c = await getSiteTrackingConfigMasked(1);
    assert.equal(c.openaiAdsPixelId, "px_1");
    assert.equal(c.openaiAdsApiKey, "••••••••");
  });
});

describe("smoke: i moduli modificati si importano", () => {
  test("import dei route/services toccati", async () => {
    await import("../src/routes/serve.js");
    await import("../src/services/static-export.js");
    await import("../src/routes/settings.js");
    await import("../src/routes/agent.js");
    await import("../src/routes/forms.js");
    await import("../src/routes/newsletter.js");
    await import("../src/routes/calls.js");
    await import("../src/routes/quizzes.js");
    assert.ok(true);
  });
});
