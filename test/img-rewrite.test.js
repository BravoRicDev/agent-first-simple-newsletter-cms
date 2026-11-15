import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createTestSite, closeDb } from "./helpers.js";
import { setBlogConfig, invalidateBlogSettingCache } from "../src/services/blog-settings.js";
import { MEDIA_ROOT, VARIANTS_ROOT, generateVariants } from "../src/services/image-variants.js";
import { rewriteImages, rewriteImagesForSite } from "../src/services/img-rewrite.js";

describe("img-rewrite", () => {
  let site, other;
  const siteDir = (id) => path.join(MEDIA_ROOT, String(id));
  const varDir = (id) => path.join(VARIANTS_ROOT, String(id));
  const img = (id, file) => `/media/${id}/${file}`;

  before(async () => {
    site = await createTestSite("ImgRewrite");
    other = await createTestSite("ImgRewriteOther");
    fs.mkdirSync(siteDir(site.id), { recursive: true });
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#3366cc" } })
      .png().toFile(path.join(siteDir(site.id), "a.png"));
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#cc3366" } })
      .png().toFile(path.join(siteDir(site.id), "b.png"));
    fs.writeFileSync(path.join(siteDir(site.id), "c.png"), "not-generated");
    fs.writeFileSync(path.join(siteDir(site.id), "g.gif"), "GIF89a");
    fs.writeFileSync(path.join(siteDir(site.id), "s.svg"), "<svg/>");
    await generateVariants(site.id, "a.png");
    await generateVariants(site.id, "b.png");
    fs.mkdirSync(siteDir(other.id), { recursive: true });
    await sharp({ create: { width: 500, height: 500, channels: 3, background: "#000000" } })
      .png().toFile(path.join(siteDir(other.id), "x.png"));
    await generateVariants(other.id, "x.png");
  });

  after(async () => {
    for (const s of [site, other]) {
      fs.rmSync(siteDir(s.id), { recursive: true, force: true });
      fs.rmSync(varDir(s.id), { recursive: true, force: true });
    }
    await closeDb();
  });

  test("mode 0: rewriteImagesForSite returns the same string", async () => {
    await setBlogConfig(site.id, { images_srcset_mode: "0" });
    invalidateBlogSettingCache(site.id);
    const html = `<p><img src="${img(site.id, "a.png")}" alt="x"></p>`;
    const out = await rewriteImagesForSite(site.id, html);
    assert.equal(out, html);
  });

  test("html without <img> is returned unchanged", async () => {
    await setBlogConfig(site.id, { images_srcset_mode: "srcset" });
    invalidateBlogSettingCache(site.id);
    const html = "<p>no images here</p>";
    assert.equal(await rewriteImagesForSite(site.id, html), html);
  });

  test("srcset mode adds srcset and sizes, no width/height added", async () => {
    await setBlogConfig(site.id, { images_srcset_mode: "srcset" });
    invalidateBlogSettingCache(site.id);
    const out = await rewriteImagesForSite(site.id, `<img src="${img(site.id, "a.png")}" alt="x">`);
    assert.ok(out.includes(`srcset="/media/_variants/${site.id}/a.png.320w.webp 320w`), out);
    assert.ok(out.includes(`sizes="100vw"`), out);
    assert.ok(!/\swidth=/i.test(out), out);
    assert.ok(!/\sheight=/i.test(out), out);
  });

  test("first image has no loading attr, second image is lazy", () => {
    const html = `<img src="${img(site.id, "a.png")}" alt="1"><img src="${img(site.id, "b.png")}" alt="2">`;
    const out = rewriteImages(html, site.id, "srcset");
    const tags = out.match(/<img\b[^>]*>/gi);
    assert.equal(tags.length, 2);
    assert.ok(!tags[0].includes("loading="), tags[0]);
    assert.ok(tags[1].includes(`loading="lazy"`), tags[1]);
    assert.ok(tags[1].includes(`decoding="async"`), tags[1]);
  });

  test("existing srcset is untouched", () => {
    const tag = `<img src="${img(site.id, "a.png")}" srcset="foo.png 1x">`;
    assert.equal(rewriteImages(tag, site.id, "srcset"), tag);
  });

  test("existing width attribute stays exactly as it was", () => {
    const out = rewriteImages(`<img src="${img(site.id, "a.png")}" width="10" alt="x">`, site.id, "srcset");
    assert.ok(out.includes(`width="10"`), out);
    assert.equal((out.match(/\swidth=/gi) || []).length, 1, out);
  });

  test("existing sizes is preserved and used", () => {
    const out = rewriteImages(`<img src="${img(site.id, "a.png")}" sizes="50vw">`, site.id, "srcset");
    assert.ok(out.includes(`sizes="50vw"`), out);
    assert.equal((out.match(/\ssizes=/gi) || []).length, 1, out);
  });

  test("non-rewritable images are byte-identical", () => {
    const cases = [
      `<img src="/media/${other.id + 1000}/a.png" alt="x">`,
      `<img src="https://cdn.example.com/a.png" alt="x">`,
      `<img src="${img(site.id, "s.svg")}" alt="x">`,
      `<img src="${img(site.id, "g.gif")}" alt="x">`,
      `<img src="${img(site.id, "c.png")}" alt="x">`,
    ];
    for (const tag of cases) {
      assert.equal(rewriteImages(tag, site.id, "srcset"), tag, tag);
    }
  });

  test("picture mode wraps with avif then webp sources", () => {
    const out = rewriteImages(`<img src="${img(site.id, "a.png")}" alt="x">`, site.id, "picture");
    assert.ok(out.startsWith("<picture><source type=\"image/avif\""), out);
    assert.ok(out.indexOf(`type="image/avif"`) < out.indexOf(`type="image/webp"`), out);
    assert.ok(out.includes(`<img src="${img(site.id, "a.png")}"`), out);
    assert.ok(out.endsWith("</picture>"), out);
  });

  test("img already inside picture is not double-wrapped", () => {
    const html = `<picture><source type="image/webp" srcset="x.webp"><img src="${img(site.id, "a.png")}" alt="x"></picture>`;
    const out = rewriteImages(html, site.id, "picture");
    assert.equal((out.match(/<picture/g) || []).length, 1, out);
    assert.ok(out.includes(`srcset="/media/_variants/${site.id}/a.png.320w.webp 320w`), out);
  });

  test("self-closing img keeps />", () => {
    const out = rewriteImages(`<img src="${img(site.id, "a.png")}" alt="x" />`, site.id, "srcset");
    assert.ok(/\/>$/.test(out), out);
    assert.ok(out.includes(`srcset="`), out);
  });
});
