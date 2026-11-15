import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { makePage } from "./ext-helpers.js";
import { publishDuePages } from "../src/services/scheduler.js";
import { setBlogConfig } from "../src/services/blog-settings.js";

// publishDuePages: il test asserisce lo STATO FINALE del DB (lo scheduler
// reale del container puo' processare le stesse righe per primo).
const PAST = () => new Date(Date.now() - 60 * 1000);

async function row(id) {
  return (await query("SELECT * FROM pages WHERE id = $1", [id])).rows[0];
}

describe("scheduler: publishDuePages hardening", () => {
  let site;

  before(async () => {
    site = await createTestSite("SchedulerPublish");
  });

  after(async () => {
    await closeDb();
  });

  test("(a) draft con publish_at passato -> published, publish_at NULL", async () => {
    const p = await makePage(site.id, { published: false, extra: { publish_at: PAST() } });
    await publishDuePages();
    const r = await row(p.id);
    assert.equal(r.published, true);
    assert.equal(r.publish_at, null);
  });

  test("(b) articolo pianificato -> published_at valorizzato e listing blog aggiornato", async () => {
    const p = await makePage(site.id, {
      post_type: "article",
      published: false,
      title: "Articolo Schedulato",
      extra: { publish_at: PAST() },
    });
    await publishDuePages();
    const r = await row(p.id);
    assert.equal(r.published, true);
    assert.notEqual(r.published_at, null);
    const listing = (await query(
      "SELECT id, content FROM pages WHERE site_id = $1 AND managed_by = 'blog_index' AND url_path = '/blog'",
      [site.id]
    )).rows;
    assert.equal(listing.length, 1, "deve esistere la pagina listing /blog");
    assert.ok(listing[0].content.includes(r.url_path), "il listing deve contenere l'articolo pubblicato");
  });

  test("(c) workflow editoriale ON: draft resta non pubblicato, approved viene pubblicato", async () => {
    await setBlogConfig(site.id, { editorial_workflow_enabled: "1" });
    const p = await makePage(site.id, {
      published: false,
      extra: { publish_at: PAST(), editorial_status: "draft" },
    });
    await publishDuePages();
    let r = await row(p.id);
    assert.equal(r.published, false, "una pagina draft non deve essere pubblicata con workflow ON");

    await query("UPDATE pages SET editorial_status = 'approved' WHERE id = $1", [p.id]);
    await publishDuePages();
    r = await row(p.id);
    assert.equal(r.published, true);
    assert.equal(r.editorial_status, "published");
    await setBlogConfig(site.id, { editorial_workflow_enabled: "0" });
  });

  test("(d) unpublish_at gia' passato viene azzerato alla pubblicazione", async () => {
    const past = new Date(Date.now() - 30 * 60 * 1000);
    const p = await makePage(site.id, {
      published: false,
      extra: { publish_at: PAST(), unpublish_at: past },
    });
    await publishDuePages();
    const r = await row(p.id);
    assert.equal(r.published, true);
    assert.equal(r.unpublish_at, null);
  });
});
