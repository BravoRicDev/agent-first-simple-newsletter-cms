import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createTestSite, closeDb } from "./helpers.js";
import { MEDIA_ROOT, VARIANTS_ROOT } from "../src/services/image-variants.js";
import {
  parseTransformParams, transformImage, deleteTransforms, originalPath,
} from "../src/services/image-transform-core.js";
import { setFocalPoint, getFocalPoint, clearFocalPoint } from "../src/services/media-focal.js";

describe("image-transform-core", () => {
  let site;
  const siteDir = () => path.join(MEDIA_ROOT, String(site.id));
  const varDir = () => path.join(VARIANTS_ROOT, String(site.id));
  const variantsOf = (name) => fs.readdirSync(varDir()).filter((n) => n.startsWith(name + ".t"));

  before(async () => {
    site = await createTestSite("ImageTransformCore");
    fs.mkdirSync(siteDir(), { recursive: true });
    fs.mkdirSync(varDir(), { recursive: true });
    // 2000x1000 PNG: left half pure red, right half pure blue
    const buf = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .composite([{ input: await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(), left: 1000, top: 0 }])
      .png().toBuffer();
    fs.writeFileSync(path.join(siteDir(), "core-wide.png"), buf);
    fs.writeFileSync(path.join(siteDir(), "core-limit.png"), buf);
    fs.writeFileSync(path.join(siteDir(), "core-focal.png"), buf);
    fs.writeFileSync(path.join(siteDir(), "core-clear.png"), buf);
  });

  after(async () => {
    fs.rmSync(siteDir(), { recursive: true, force: true });
    fs.rmSync(varDir(), { recursive: true, force: true });
    await closeDb();
  });

  test("parseTransformParams: defaults and format negotiation", () => {
    const p = parseTransformParams({ w: "640" }, "");
    assert.equal(p.w, 640);
    assert.equal(p.h, null);
    assert.equal(p.fmt, "orig");
    assert.equal(p.q, 80);
    const a = parseTransformParams({ w: "640", fmt: "auto" }, "image/avif,image/webp,*/*");
    assert.equal(a.fmt, "avif");
    const j = parseTransformParams({ w: "640", fmt: "jpg" }, "");
    assert.equal(j.fmt, "jpeg");
  });

  test("parseTransformParams: validation errors", () => {
    const code = (q) => { try { parseTransformParams(q, ""); return null; } catch (e) { return e.code; } };
    assert.equal(code({ w: "641" }), "invalid_width");
    assert.equal(code({ w: "640", h: "500" }), "invalid_aspect");
    assert.equal(code({ w: "640", h: "9999" }), "invalid_height");
    assert.equal(code({ w: "640", fmt: "gif" }), "invalid_format");
    assert.equal(code({ w: "640", q: "10" }), "invalid_quality");
    assert.equal(code({ w: "640", h: "480" }), null);
    assert.equal(parseTransformParams({ w: "640", q: "83" }, "").q, 80);
    try { parseTransformParams({ w: "641" }, ""); } catch (e) { assert.equal(e.status, 400); }
  });

  test("transformImage: width-only webp is generated, then reused", async () => {
    const params = parseTransformParams({ w: "640", fmt: "webp" }, "");
    const r1 = await transformImage(site.id, "core-wide.png", params);
    assert.equal(r1.mime, "image/webp");
    assert.equal(fs.existsSync(r1.file), true);
    assert.equal((await sharp(r1.file).metadata()).width, 640);
    const mtime1 = fs.statSync(r1.file).mtimeMs;
    const r2 = await transformImage(site.id, "core-wide.png", params);
    assert.equal(r2.file, r1.file);
    assert.equal(fs.statSync(r2.file).mtimeMs, mtime1);
  });

  test("transformImage: focal point changes the crop", async () => {
    await setFocalPoint(site.id, "core-wide.png", 0, 0.5);
    const left = await transformImage(site.id, "core-wide.png", parseTransformParams({ w: "640", h: "640", fmt: "png" }, ""));
    const sl = (await sharp(left.file).stats()).channels;
    await setFocalPoint(site.id, "core-wide.png", 1, 0.5);
    const right = await transformImage(site.id, "core-wide.png", parseTransformParams({ w: "640", h: "640", fmt: "png" }, ""));
    assert.notEqual(left.file, right.file);
    const sr = (await sharp(right.file).stats()).channels;
    assert.ok(sl[0].mean > 200 && sl[2].mean < 50, "focal (0,0.5) must crop the red half");
    assert.ok(sr[2].mean > 200 && sr[0].mean < 50, "focal (1,0.5) must crop the blue half");
  });

  test("transformImage: unknown file -> 404, unsupported type -> 400", async () => {
    const params = parseTransformParams({ w: "640" }, "");
    await assert.rejects(transformImage(site.id, "missing-core.png", params), (e) => e.status === 404);
    await assert.rejects(transformImage(site.id, "x.gif", params), (e) => e.status === 400);
  });

  test("transformImage: too many variants -> 429 too_many_variants", async () => {
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(varDir(), `core-limit.png.tfake${i}`), "x");
    await assert.rejects(
      transformImage(site.id, "core-limit.png", parseTransformParams({ w: "640", fmt: "webp" }, "")),
      (e) => e.status === 429 && e.code === "too_many_variants",
    );
    assert.equal(variantsOf("core-limit.png").length, 40);
  });

  test("setFocalPoint: validation and persistence", async () => {
    await assert.rejects(setFocalPoint(site.id, "core-focal.png", 1.5, 0.5), (e) => e.code === "INVALID_FOCAL");
    await assert.rejects(setFocalPoint(site.id, "nope-core.png", 0.5, 0.5), (e) => e.code === "MEDIA_NOT_FOUND");
    await setFocalPoint(site.id, "core-focal.png", "0.25", "0.75");
    assert.deepEqual(await getFocalPoint(site.id, "core-focal.png"), { x: 0.25, y: 0.75 });
  });

  test("changing or clearing the focal point deletes cached transforms", async () => {
    await transformImage(site.id, "core-clear.png", parseTransformParams({ w: "640", h: "640", fmt: "png" }, ""));
    assert.ok(variantsOf("core-clear.png").length > 0);
    await setFocalPoint(site.id, "core-clear.png", 0.3, 0.3);
    assert.equal(variantsOf("core-clear.png").length, 0);
    await transformImage(site.id, "core-clear.png", parseTransformParams({ w: "640", h: "640", fmt: "png" }, ""));
    assert.ok((await deleteTransforms(site.id, "core-clear.png")) > 0);
    await transformImage(site.id, "core-clear.png", parseTransformParams({ w: "640", h: "640", fmt: "png" }, ""));
    await clearFocalPoint(site.id, "core-clear.png");
    assert.equal(await getFocalPoint(site.id, "core-clear.png"), null);
    assert.equal(variantsOf("core-clear.png").length, 0);
  });
});
