import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "../locales");
const TMP_FRAGMENT = path.join(LOCALES_DIR, "en.d", "zz-test-tmp.json");

describe("i18n fragments loader", () => {
  after(() => {
    try { fs.unlinkSync(TMP_FRAGMENT); } catch { /* gia' rimosso */ }
  });

  test("(a) fragment keys are loaded for en and it", async () => {
    const { translate } = await import("../src/middleware/i18n.js?x=" + Date.now());
    assert.equal(translate("en", "ext.core.loaded"), "ok");
    assert.equal(translate("it", "ext.core.loaded"), "ok");
  });

  test("(b) base keys still resolve", async () => {
    const { translate } = await import("../src/middleware/i18n.js?x=" + Date.now());
    assert.equal(translate("en", "nav.dashboard"), "Dashboard");
  });

  test("(c) unknown key returns the key itself", async () => {
    const { translate } = await import("../src/middleware/i18n.js?x=" + Date.now());
    assert.equal(translate("en", "does.not.exist"), "does.not.exist");
  });

  test("(d) fragments never override base keys, but add new keys", async () => {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en.json"), "utf8"));
    const K = Object.keys(en)[0];
    fs.writeFileSync(TMP_FRAGMENT, JSON.stringify({ [K]: "HACK", "zz.tmp": "1" }));
    const { translate } = await import("../src/middleware/i18n.js?x=" + Date.now());
    assert.notEqual(translate("en", K), "HACK");
    assert.equal(translate("en", "zz.tmp"), "1");
  });
});
