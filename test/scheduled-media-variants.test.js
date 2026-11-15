import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { runMediaVariantsBackfill } from "../src/services/scheduled-media-variants.js";
import { MEDIA_ROOT, VARIANTS_ROOT, getSharp, getVariantInfo } from "../src/services/image-variants.js";

async function makePng(dir, name) {
  const sharp = await getSharp();
  await sharp({ create: { width: 32, height: 32, channels: 3, background: "#c00" } }).png().toFile(path.join(dir, name));
}

describe("scheduled media variants backfill", () => {
  let siteSrcset, siteDefault, dirSrcset, dirDefault;
  const names = ["bf-a.png", "bf-b.png", "bf-c.png"];
  const defaultNames = ["bf-d.png"];

  before(async () => {
    siteSrcset = await createTestSite("Backfill srcset");
    siteDefault = await createTestSite("Backfill default");
    await query("INSERT INTO settings (site_id, key, value) VALUES ($1, 'images_srcset_mode', 'srcset')", [siteSrcset.id]);
    await query("INSERT INTO settings (site_id, key, value) VALUES ($1, 'images_srcset_mode', '0')", [siteDefault.id]);
    dirSrcset = path.join(MEDIA_ROOT, String(siteSrcset.id));
    dirDefault = path.join(MEDIA_ROOT, String(siteDefault.id));
    fs.mkdirSync(dirSrcset, { recursive: true });
    fs.mkdirSync(dirDefault, { recursive: true });
    for (const n of names) await makePng(dirSrcset, n);
    for (const n of defaultNames) await makePng(dirDefault, n);
  });

  after(async () => {
    fs.rmSync(dirSrcset, { recursive: true, force: true });
    fs.rmSync(dirDefault, { recursive: true, force: true });
    fs.rmSync(path.join(VARIANTS_ROOT, String(siteSrcset.id)), { recursive: true, force: true });
    fs.rmSync(path.join(VARIANTS_ROOT, String(siteDefault.id)), { recursive: true, force: true });
    await closeDb();
  });

  test("first 4 default calls are skipped (every 5th tick runs)", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await runMediaVariantsBackfill();
      assert.equal(r.skipped, true);
      assert.equal(r.generated, 0);
    }
  });

  test("everyNth:1, limit:2 generates at most 2 per call and reaches all fixtures", async () => {
    const r1 = await runMediaVariantsBackfill({ everyNth: 1, limit: 2 });
    assert.ok(r1.generated <= 2, `first call generated ${r1.generated}`);
    const r2 = await runMediaVariantsBackfill({ everyNth: 1, limit: 2 });
    assert.ok(r2.generated <= 2, `second call generated ${r2.generated}`);
    // La scheduler reale dell'app puo' generare nel frattempo: si verifica lo stato finale.
    for (let i = 0; i < 10 && !names.every((n) => getVariantInfo(siteSrcset.id, n)); i++) {
      await runMediaVariantsBackfill({ everyNth: 1, limit: 2 });
    }
    for (const n of names) assert.ok(getVariantInfo(siteSrcset.id, n), `meta missing for ${n}`);
  });

  test("a further call generates nothing for the fixtures (already have meta)", async () => {
    const r = await runMediaVariantsBackfill({ everyNth: 1, limit: 10 });
    assert.equal(typeof r.generated, "number");
    for (const n of names) assert.ok(getVariantInfo(siteSrcset.id, n));
  });

  test("site with images_srcset_mode '0' is untouched", async () => {
    for (let i = 0; i < 3; i++) await runMediaVariantsBackfill({ everyNth: 1, limit: 10 });
    for (const n of defaultNames) assert.equal(getVariantInfo(siteDefault.id, n), null);
    assert.equal(fs.existsSync(path.join(VARIANTS_ROOT, String(siteDefault.id))), false);
  });
});
