import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, addDomain, sessionCookie, makePage } from "./ext-helpers.js";
import { query } from "../src/db.js";
import { invalidateBlogSettingCache } from "../src/services/blog-settings.js";
import searchPublicRoutes from "../src/routes/search-public.js";

const word = () => "sp" + crypto.randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d)));

describe("public + admin search router", () => {
  let site, otherSite, admin, otherAdmin, domain, otherDomain, app;
  let cookie, otherCookie;

  before(async () => {
    site = await createTestSite("SearchPublic A");
    otherSite = await createTestSite("SearchPublic B");
    admin = await createTestUser(site.id, "admin");
    otherAdmin = await createTestUser(otherSite.id, "admin");
    domain = await addDomain(site.id);
    otherDomain = await addDomain(otherSite.id);
    cookie = await sessionCookie(admin.id);
    otherCookie = await sessionCookie(otherAdmin.id);
    app = await startApp({ routers: [searchPublicRoutes] });
  });

  after(async () => { app.close(); await closeDb(); });

  const enableSearch = async (siteId, value) => {
    await query(
      `INSERT INTO settings (site_id, key, value) VALUES ($1, 'search_enabled', $2)
       ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value`, [siteId, value]);
    invalidateBlogSettingCache(siteId);
  };

  test("public search disabled by default -> 404 search_disabled", async () => {
    const r = await httpReq(app.baseUrl, "/api/public/search?q=hello", { host: domain });
    assert.equal(r.status, 404);
    assert.equal(r.json().error, "search_disabled");
  });

  test("unknown host -> 404", async () => {
    await enableSearch(site.id, "1");
    const r = await httpReq(app.baseUrl, "/api/public/search?q=hello", { host: "unknown-host.invalid" });
    assert.equal(r.status, 404);
  });

  test("enabled: 200 with results array and cache-control max-age=60", async () => {
    await enableSearch(site.id, "1");
    const r = await httpReq(app.baseUrl, "/api/public/search?q=nothingmatcheshere", { host: domain });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json().results));
    assert.ok(String(r.headers["cache-control"]).includes("max-age=60"));
  });

  test("missing / short / 101-char q -> 400 invalid_query", async () => {
    const missing = await httpReq(app.baseUrl, "/api/public/search", { host: domain });
    assert.equal(missing.status, 400);
    const short = await httpReq(app.baseUrl, "/api/public/search?q=a", { host: domain });
    assert.equal(short.status, 400);
    const long = await httpReq(app.baseUrl, "/api/public/search?q=" + "a".repeat(101), { host: domain });
    assert.equal(long.status, 400);
    assert.equal(long.json().error, "invalid_query");
  });

  test("draft page is never public but is returned by admin search", async () => {
    const publishedWord = word();
    const draftWord = word();
    const pub = await makePage(site.id, { title: publishedWord, content: `<p>${publishedWord} contenuto</p>`, published: true });
    const draft = await makePage(site.id, { title: draftWord, content: `<p>${draftWord} bozza</p>`, published: false });

    const pubRes = await httpReq(app.baseUrl, `/api/public/search?q=${publishedWord}`, { host: domain });
    assert.equal(pubRes.status, 200);
    assert.ok(pubRes.json().results.some((x) => x.id === pub.id));

    const draftPublic = await httpReq(app.baseUrl, `/api/public/search?q=${draftWord}`, { host: domain });
    assert.equal(draftPublic.status, 200);
    assert.equal(draftPublic.json().results.length, 0);

    const draftAdmin = await httpReq(app.baseUrl, `/admin/api/search?q=${draftWord}`, { headers: { Cookie: cookie } });
    assert.equal(draftAdmin.status, 200);
    assert.ok(draftAdmin.json().results.some((x) => x.id === draft.id));
  });

  test("admin of another site cannot see site A pages", async () => {
    const w = word();
    await makePage(site.id, { title: w, content: `<p>${w}</p>`, published: true });
    const r = await httpReq(app.baseUrl, `/admin/api/search?q=${w}`, { headers: { Cookie: otherCookie } });
    assert.equal(r.status, 200);
    assert.equal(r.json().results.length, 0);
  });

  test("admin search without cookie is not 200", async () => {
    const r = await httpReq(app.baseUrl, "/admin/api/search?q=hello");
    assert.notEqual(r.status, 200);
  });
});
