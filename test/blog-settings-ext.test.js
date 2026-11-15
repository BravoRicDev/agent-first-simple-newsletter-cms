import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { getBlogConfig, setBlogConfig, getBlogSetting } from "../src/services/blog-settings.js";

describe("blog settings: nuove chiavi e lettura con cache", () => {
  let site;
  before(async () => { site = await createTestSite("Blog Settings Ext Test"); });
  after(async () => { await closeDb(); });

  test("default delle nuove chiavi", async () => {
    const config = await getBlogConfig(site.id);
    assert.equal(config.feed_enabled, "0");
    assert.equal(config.search_language, "italian");
    assert.equal(config.images_srcset_mode, "0");
  });

  test("setBlogConfig e getBlogSetting leggono subito il nuovo valore", async () => {
    await setBlogConfig(site.id, { feed_enabled: "1" });
    assert.equal(await getBlogSetting(site.id, "feed_enabled"), "1");
  });

  test("ritorno a \"0\" viene salvato e letto come \"0\"", async () => {
    await setBlogConfig(site.id, { feed_enabled: "0" });
    assert.equal(await getBlogSetting(site.id, "feed_enabled"), "0");
  });

  test("chiave sconosciuta ritorna stringa vuota", async () => {
    assert.equal(await getBlogSetting(site.id, "nope"), "");
  });
});
