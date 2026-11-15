import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, sessionCookie, makePage, noSmtp } from "./ext-helpers.js";
import adminReleasesRouter from "../src/routes/admin-releases.js";

const post = (app, path, cookie, o) => httpReq(app.baseUrl, path, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
  body: new URLSearchParams(o).toString(),
});

describe("admin releases router", () => {
  let site, admin, collab, other, otherAdmin, app, adminCookie, collabCookie, otherCookie, page, releaseId;

  before(async () => {
    noSmtp();
    site = await createTestSite("Releases");
    admin = await createTestUser(site.id, "admin");
    collab = await createTestUser(site.id, "collaboratore");
    other = await createTestSite("Releases other");
    otherAdmin = await createTestUser(other.id, "admin");
    adminCookie = await sessionCookie(admin.id);
    collabCookie = await sessionCookie(collab.id);
    otherCookie = await sessionCookie(otherAdmin.id);
    page = await makePage(site.id, { url_path: "/rel-page", title: "Rel", published: false });
    app = await startApp({ views: true, routers: [adminReleasesRouter] });
  });

  after(async () => { app.close(); await closeDb(); });

  test("admin crea release -> 302 verso dettaglio", async () => {
    const r = await post(app, `/admin/releases?site_id=${site.id}`, adminCookie, { name: "Spring" });
    assert.equal(r.status, 302);
    const loc = r.headers.location;
    assert.ok(loc.startsWith("/admin/releases/"), loc);
    assert.ok(loc.includes(`?site_id=${site.id}`), loc);
    releaseId = parseInt(loc.split("/")[3], 10);
    const row = (await query("SELECT status FROM releases WHERE id = $1", [releaseId])).rows[0];
    assert.equal(row.status, "draft");
  });

  test("aggiunta pagine -> msg=items_added e riga in release_items", async () => {
    const r = await post(app, `/admin/releases/${releaseId}/items?site_id=${site.id}`, adminCookie, { page_ids: String(page.id), action: "publish" });
    assert.equal(r.status, 302);
    assert.ok(r.headers.location.includes("msg=items_added"), r.headers.location);
    const n = (await query("SELECT COUNT(*)::int AS n FROM release_items WHERE release_id = $1 AND page_id = $2", [releaseId, page.id])).rows[0].n;
    assert.equal(n, 1);
  });

  test("schedule da admin -> release scheduled nel DB", async () => {
    const when = new Date(Date.now() + 7200e3).toISOString().slice(0, 16);
    const r = await post(app, `/admin/releases/${releaseId}/schedule?site_id=${site.id}`, adminCookie, { scheduled_at: when });
    assert.equal(r.status, 302);
    assert.ok(r.headers.location.includes("msg=scheduled"), r.headers.location);
    const row = (await query("SELECT status FROM releases WHERE id = $1", [releaseId])).rows[0];
    assert.equal(row.status, "scheduled");
  });

  test("schedule da collaboratore -> err=forbidden", async () => {
    const when = new Date(Date.now() + 7200e3).toISOString().slice(0, 16);
    const r = await post(app, `/admin/releases/${releaseId}/schedule?site_id=${site.id}`, collabCookie, { scheduled_at: when });
    assert.equal(r.status, 302);
    assert.ok(r.headers.location.includes("err=forbidden"), r.headers.location);
  });

  test("utente di un altro sito -> GET dettaglio 404", async () => {
    const r = await httpReq(app.baseUrl, `/admin/releases/${releaseId}?site_id=${site.id}`, { headers: { cookie: otherCookie } });
    assert.notEqual(r.status, 200);
    assert.equal(r.status, 404);
  });

  test("POST con id non numerico -> 400", async () => {
    const r = await post(app, `/admin/releases/abc/cancel?site_id=${site.id}`, adminCookie, {});
    assert.equal(r.status, 400);
  });
});
