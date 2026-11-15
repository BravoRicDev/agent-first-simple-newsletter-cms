import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createTestSite, closeDb } from "./helpers.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import {
  MEDIA_ROOT, VARIANTS_ROOT, WIDTHS, isEligible, generateVariants, getVariantInfo,
  queueVariants, deleteVariants, deleteTransforms, buildSrcset, variantsDir,
} from "../src/services/image-variants.js";

describe("image-variants core", () => {
  let site;
  const siteDir = () => path.join(MEDIA_ROOT, String(site.id));
  const varDir = () => path.join(VARIANTS_ROOT, String(site.id));

  before(async () => {
    site = await createTestSite("ImageVariants");
    fs.mkdirSync(siteDir(), { recursive: true });
  });

  after(async () => {
    fs.rmSync(siteDir(), { recursive: true, force: true });
    fs.rmSync(varDir(), { recursive: true, force: true });
    await closeDb();
  });

  test("isEligible accepts jpg/png/webp and rejects others", () => {
    assert.equal(isEligible("a.jpg"), true);
    assert.equal(isEligible("b.PNG"), true);
    assert.equal(isEligible("c.webp"), true);
    assert.equal(isEligible("x.gif"), false);
    assert.equal(isEligible("y.svg"), false);
    assert.equal(isEligible("z.mp4"), false);
    assert.equal(isEligible("../a.jpg"), false);
    assert.equal(isEligible(".hidden.jpg"), false);
  });

  test("2000x1000 PNG generates all widths in webp and avif", async () => {
    const name = "wide.png";
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#3366cc" } })
      .png().toFile(path.join(siteDir(), name));
    const r = await generateVariants(site.id, name);
    assert.deepEqual(r.widths, [320, 480, 640, 800, 1024, 1280, 1600, 1920, 2000]);
    assert.deepEqual(WIDTHS, [320, 480, 640, 800, 1024, 1280, 1600, 1920]);
    for (const w of r.widths) {
      for (const fmt of ["webp", "avif"]) {
        assert.ok(fs.existsSync(path.join(varDir(), `${name}.${w}w.${fmt}`)), `missing ${w}w.${fmt}`);
      }
    }
    const info = getVariantInfo(site.id, name);
    assert.equal(info.width, 2000);
    assert.equal(info.height, 1000);
  });

  test("400x300 JPG generates only [320, 400]", async () => {
    const name = "small.jpg";
    await sharp({ create: { width: 400, height: 300, channels: 3, background: "#cc3366" } })
      .jpeg().toFile(path.join(siteDir(), name));
    const r = await generateVariants(site.id, name);
    assert.deepEqual(r.widths, [320, 400]);
  });

  test("second generation is idempotent (written === 0)", async () => {
    const r = await generateVariants(site.id, "small.jpg");
    assert.equal(r.written, 0);
  });

  test("buildSrcset lists variant urls, unknown file gives empty string", async () => {
    const s = buildSrcset(site.id, "wide.png", "webp");
    assert.ok(s.startsWith(`/media/_variants/${site.id}/wide.png.320w.webp 320w, `), s);
    assert.ok(s.endsWith(`/media/_variants/${site.id}/wide.png.2000w.webp 2000w`), s);
    assert.equal(buildSrcset(site.id, "unknown.png", "webp"), "");
  });

  test("deleteVariants removes files of one original only", async () => {
    const other = "other.png";
    await sharp({ create: { width: 500, height: 500, channels: 3, background: "#000" } })
      .png().toFile(path.join(siteDir(), other));
    await generateVariants(site.id, other);
    const before = fs.readdirSync(varDir()).filter((f) => f.startsWith("small.jpg")).length;
    assert.ok(before > 0);
    const n = await deleteVariants(site.id, "small.jpg");
    assert.equal(n, before);
    assert.equal(fs.readdirSync(varDir()).filter((f) => f.startsWith("small.jpg")).length, 0);
    assert.ok(fs.readdirSync(varDir()).some((f) => f.startsWith(other)), "other file variants must stay");
    assert.equal(getVariantInfo(site.id, "small.jpg"), null);
  });

  test("queueVariants respects images_srcset_mode (default 0 writes nothing, force ignores it)", async () => {
    const name = "queued.png";
    await sharp({ create: { width: 700, height: 500, channels: 3, background: "#0f0" } })
      .png().toFile(path.join(siteDir(), name));
    await queueVariants(site.id, name);
    assert.equal(getVariantInfo(site.id, name), null);
    assert.equal(fs.existsSync(varDir()) ? fs.readdirSync(varDir()).filter((f) => f.startsWith(name)).length : 0, 0);

    await setBlogConfig(site.id, { images_srcset_mode: "srcset" });
    await queueVariants(site.id, name);
    assert.notEqual(getVariantInfo(site.id, name), null);

    await setBlogConfig(site.id, { images_srcset_mode: "0" });
    await deleteVariants(site.id, name);
    await queueVariants(site.id, name, { force: true });
    assert.notEqual(getVariantInfo(site.id, name), null);
  });

  test("EXIF orientation 6 swaps reported dimensions", async () => {
    const name = "rotated.jpg";
    await sharp({ create: { width: 800, height: 400, channels: 3, background: "#999" } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(path.join(siteDir(), name));
    const r = await generateVariants(site.id, name);
    assert.equal(r.width, 400);
    assert.equal(r.height, 800);
  });

  test("corrupt file rejects in generateVariants; queueVariants swallows the error", async () => {
    const name = "corrupt.jpg";
    fs.writeFileSync(path.join(siteDir(), name), Buffer.from("not an image at all ".repeat(50)));
    await setBlogConfig(site.id, { images_srcset_mode: "srcset" });
    await assert.rejects(generateVariants(site.id, name));
    await assert.doesNotReject(queueVariants(site.id, name));
    await setBlogConfig(site.id, { images_srcset_mode: "0" });
  });

  test("deleteTransforms removes only <file>.t* files", async () => {
    const dir = variantsDir(site.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wide.png.t1.webp"), "x");
    fs.writeFileSync(path.join(dir, "wide.png.t2.avif"), "x");
    const keep = path.join(dir, "small.jpg.t1.webp");
    fs.writeFileSync(keep, "x");
    const n = await deleteTransforms(site.id, "wide.png");
    assert.equal(n, 2);
    assert.equal(fs.existsSync(path.join(dir, "wide.png.t1.webp")), false);
    assert.equal(fs.existsSync(keep), true);
    fs.rmSync(keep, { force: true });
  });

  test("decompression bomb is rejected with pixel limit error", async () => {
    const name = "bomb.png";
    await sharp({ create: { width: 15000, height: 15000, channels: 3, background: "#fff" } })
      .png().toFile(path.join(siteDir(), name));
    await assert.rejects(generateVariants(site.id, name), (err) => /pixel limit/i.test(err.message));
  });
});
