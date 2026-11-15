import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, sessionCookie } from "./ext-helpers.js";
import imageTransformRouter from "../src/routes/image-transform.js";
import { getSharp, MEDIA_ROOT, VARIANTS_ROOT } from "../src/services/image-variants.js";
import { query } from "../src/db.js";

describe("public /img transform route + admin focal endpoint", () => {
  let site, other, admin, otherAdmin, app, sharp;
  const dirs = [];

  before(async () => {
    site = await createTestSite("ImgRoute");
    other = await createTestSite("ImgRouteOther");
    admin = await createTestUser(site.id, "admin");
    otherAdmin = await createTestUser(other.id, "admin");
    sharp = await getSharp();
    const dir = path.join(MEDIA_ROOT, String(site.id));
    fs.mkdirSync(dir, { recursive: true });
    dirs.push(dir, path.join(VARIANTS_ROOT, String(site.id)));
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toBuffer();
    fs.writeFileSync(path.join(dir, "a.png"), png);
    app = await startApp({ routers: [imageTransformRouter] });
  });

  after(async () => {
    app?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    await closeDb();
  });

  test("w=640 fmt=webp -> 200 webp, immutable, decodes to width 640", async () => {
    const r = await httpReq(app.baseUrl, `/img/${site.id}/a.png?w=640&fmt=webp`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/webp");
    assert.match(r.headers["cache-control"], /immutable/);
    const meta = await sharp(r.buffer).metadata();
    assert.equal(meta.width, 640);
  });

  test("fmt=avif -> image/avif", async () => {
    const r = await httpReq(app.baseUrl, `/img/${site.id}/a.png?w=640&fmt=avif`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/avif");
  });

  test("fmt=auto with Accept image/webp -> webp + vary Accept", async () => {
    const r = await httpReq(app.baseUrl, `/img/${site.id}/a.png?w=640`, { headers: { Accept: "image/webp,*/*" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/webp");
    assert.match(String(r.headers["vary"] || ""), /Accept/);
  });

  test("w=641 -> 400 invalid_width", async () => {
    const r = await httpReq(app.baseUrl, `/img/${site.id}/a.png?w=641&fmt=webp`);
    assert.equal(r.status, 400);
    assert.equal(r.json().error, "invalid_width");
  });

  test("encoded path traversal ..%2Fx.png is never 200", async () => {
    const r = await httpReq(app.baseUrl, `/img/${site.id}/..%2Fx.png?w=640&fmt=webp`);
    assert.notEqual(r.status, 200);
    assert.ok([400, 404].includes(r.status));
  });

  test("x.gif -> 400 unsupported_type", async () => {
    const r = await httpReq(app.baseUrl, `/img/${site.id}/x.gif?w=640&fmt=webp`);
    assert.equal(r.status, 400);
  });

  test("unknown file -> 404", async () => {
    const r = await httpReq(app.baseUrl, `/img/${site.id}/nope.png?w=640&fmt=webp`);
    assert.equal(r.status, 404);
  });

  test("siteId 01 -> 400 invalid_site", async () => {
    const r = await httpReq(app.baseUrl, `/img/01/a.png?w=640&fmt=webp`);
    assert.equal(r.status, 400);
    assert.equal(r.json().error, "invalid_site");
  });

  test("focal POST x=0.2 y=0.8 -> 200 and DB row", async () => {
    const cookie = await sessionCookie(admin.id);
    const r = await httpReq(app.baseUrl, "/admin/media/focal", {
      method: "POST", headers: { Cookie: cookie }, body: { filename: "a.png", x: 0.2, y: 0.8 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json().ok, true);
    const row = (await query("SELECT x, y FROM media_focal_points WHERE site_id = $1 AND filename = $2", [site.id, "a.png"])).rows[0];
    assert.ok(row);
    assert.equal(Number(row.x), 0.2);
    assert.equal(Number(row.y), 0.8);
  });

  test("focal POST x=2 -> 400 invalid_focal", async () => {
    const cookie = await sessionCookie(admin.id);
    const r = await httpReq(app.baseUrl, "/admin/media/focal", {
      method: "POST", headers: { Cookie: cookie }, body: { filename: "a.png", x: 2, y: 0.5 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json().error, "invalid_focal");
  });

  test("other-site admin cannot set focal for site A file -> 404 media_not_found", async () => {
    const cookie = await sessionCookie(otherAdmin.id);
    const r = await httpReq(app.baseUrl, "/admin/media/focal", {
      method: "POST", headers: { Cookie: cookie }, body: { filename: "a.png", x: 0.5, y: 0.5 },
    });
    assert.equal(r.status, 404);
    assert.equal(r.json().error, "media_not_found");
  });
});
