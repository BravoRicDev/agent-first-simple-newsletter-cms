import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { makePage, makeCategory, noSmtp } from "./ext-helpers.js";
import { query } from "../src/db.js";
import {
  createRelease, listReleases, getRelease, addItems, removeItem, previewRelease, scheduleRelease,
  cancelRelease, rebaseRelease, executeRelease, mapReleaseError,
} from "../src/services/releases.js";

const rnd = () => crypto.randomBytes(4).toString("hex");
const future = (ms = 3600_000) => new Date(Date.now() + ms);
const past = (ms = 3600_000) => new Date(Date.now() - ms);

describe("releases service", () => {
  let site, admin, collab, cat;

  before(async () => {
    noSmtp();
    site = await createTestSite("Releases");
    admin = await createTestUser(site.id, "admin");
    collab = await createTestUser(site.id, "collaboratore");
    cat = await makeCategory(site.id, "News", `news-${rnd()}`);
  });

  after(async () => { await closeDb(); });

  // Pagine base per ogni test: P1 non pubblicata, P2 pubblicata, P3 articolo non pubblicato con categoria.
  async function mkPages() {
    const p1 = await makePage(site.id, { published: false, title: `P1-${rnd()}` });
    const p2 = await makePage(site.id, { published: true, title: `P2-${rnd()}` });
    const p3 = await makePage(site.id, { published: false, post_type: "article", category_id: cat.id, title: `ART-${rnd()}` });
    return { p1, p2, p3 };
  }

  test("(1) create / list / get", async () => {
    const rel = await createRelease(site.id, { name: "  Lancio  ", description: "d" }, admin);
    assert.equal(rel.name, "Lancio");
    assert.equal(rel.status, "draft");
    const list = await listReleases(site.id, { status: "draft" });
    assert.ok(list.some((r) => r.id === rel.id && r.item_count === 0));
    const got = await getRelease(site.id, rel.id);
    assert.equal(got.release.id, rel.id);
    assert.deepEqual(got.items, []);
    await assert.rejects(createRelease(site.id, { name: "   " }, admin), (e) => e.code === "INVALID_NAME");
    await assert.rejects(getRelease(site.id, 999999999), (e) => e.code === "RELEASE_NOT_FOUND");
  });

  test("(2) addItems validates action and site, re-adding updates action", async () => {
    const { p1, p2 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Items" }, admin);
    await assert.rejects(addItems(site.id, rel.id, [{ page_id: p1.id, action: "bogus" }], admin), (e) => e.code === "INVALID_ACTION");
    await assert.rejects(addItems(site.id, rel.id, [], admin), (e) => e.code === "INVALID_ACTION");

    const other = await createTestSite("Other");
    const foreign = await makePage(other.id, { published: false });
    await assert.rejects(addItems(site.id, rel.id, [{ page_id: foreign.id, action: "publish" }], admin), (e) => {
      assert.equal(e.code, "PAGE_NOT_IN_SITE");
      assert.deepEqual(e.page_ids, [foreign.id]);
      return true;
    });

    const managed = await makePage(site.id, { published: false });
    await query("UPDATE pages SET managed_by = 'blog_index' WHERE id = $1", [managed.id]);
    await assert.rejects(addItems(site.id, rel.id, [{ page_id: managed.id, action: "publish" }], admin), (e) => e.code === "PAGE_NOT_IN_SITE");

    await addItems(site.id, rel.id, [{ page_id: p1.id, action: "publish" }], admin);
    const after2 = await addItems(site.id, rel.id, [{ page_id: p1.id, action: "unpublish" }, { page_id: p2.id, action: "unpublish" }], admin);
    const row1 = after2.items.find((i) => i.page_id === p1.id);
    assert.equal(row1.action, "unpublish");
    assert.equal(after2.items.length, 2);
    await removeItem(site.id, rel.id, p2.id);
    assert.equal((await getRelease(site.id, rel.id)).items.length, 1);
  });

  test("(3) preview flags changes and has no side effects", async () => {
    const { p1, p2 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Preview" }, admin);
    await addItems(site.id, rel.id, [{ page_id: p1.id, action: "publish" }, { page_id: p2.id, action: "publish" }], admin);
    const snap = async () => (await query("SELECT id, published, updated_at FROM pages WHERE id = ANY($1::int[]) ORDER BY id", [[p1.id, p2.id]])).rows;
    const before3 = await snap();
    const pv = await previewRelease(site.id, rel.id);
    const r1 = pv.items.find((i) => i.page_id === p1.id);
    const r2 = pv.items.find((i) => i.page_id === p2.id);
    assert.equal(r1.will_change, true);
    assert.equal(r2.will_change, false);
    assert.equal(pv.summary.will_change, 1);
    assert.equal(pv.summary.no_op, 1);
    assert.deepEqual(await snap(), before3);
  });

  test("(4) scheduleRelease permissions, past date, empty release, ok", async () => {
    const { p1 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Sched" }, admin);
    await assert.rejects(scheduleRelease(site.id, rel.id, future(), collab), (e) => e.code === "FORBIDDEN");
    await assert.rejects(scheduleRelease(site.id, rel.id, future(), admin), (e) => e.code === "NO_ITEMS");
    await addItems(site.id, rel.id, [{ page_id: p1.id, action: "publish" }], admin);
    await assert.rejects(scheduleRelease(site.id, rel.id, past(), admin), (e) => e.code === "SCHEDULE_PAST");
    const ok = await scheduleRelease(site.id, rel.id, future(), admin);
    assert.equal(ok.release.status, "scheduled");
    assert.equal(ok.preview.total, 1);
  });

  test("(5) scheduler executes publish + unpublish atomically with snapshots, sync and audit", async () => {
    const { p1, p2, p3 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Exec" }, admin);
    await addItems(site.id, rel.id, [
      { page_id: p1.id, action: "publish" }, { page_id: p2.id, action: "unpublish" }, { page_id: p3.id, action: "publish" },
    ], admin);
    await scheduleRelease(site.id, rel.id, future(), admin);
    const res = await executeRelease(rel.id, { source: "scheduler" });
    assert.equal(res.ok, true);

    const st = Object.fromEntries((await query("SELECT id, published FROM pages WHERE id = ANY($1::int[])", [[p1.id, p2.id, p3.id]])).rows.map((r) => [r.id, r.published]));
    assert.equal(st[p1.id], true);
    assert.equal(st[p2.id], false);
    assert.equal(st[p3.id], true);

    const relRow = (await query("SELECT status, result FROM releases WHERE id = $1", [rel.id])).rows[0];
    assert.equal(relRow.status, "done");
    assert.equal(relRow.result.changed, 3);

    const vers = (await query("SELECT page_id, source, label FROM page_versions WHERE label = $1", [`release-${rel.id}`])).rows;
    assert.equal(vers.length, 3);
    assert.ok(vers.every((v) => v.source === "release"));

    const listing = (await query("SELECT content FROM pages WHERE site_id = $1 AND managed_by = 'blog_index'", [site.id])).rows[0];
    assert.ok(listing && listing.content.includes(String(await titleOf(p3.id))), "il listing /blog deve contenere l'articolo");

    const audits = (await query("SELECT action FROM audit_log WHERE entity_type = 'release' AND entity_id = $1", [rel.id])).rows.map((r) => r.action);
    assert.ok(audits.includes("release_execute"));
    const pageAudits = (await query("SELECT action FROM audit_log WHERE entity_type = 'page' AND entity_id = ANY($1::int[])", [[p1.id, p2.id, p3.id]])).rows.map((r) => r.action);
    assert.ok(pageAudits.includes("publish"));
    assert.ok(pageAudits.includes("unpublish"));
  });

  async function titleOf(id) {
    return (await query("SELECT title FROM pages WHERE id = $1", [id])).rows[0].title;
  }

  test("(6) conflict is atomic; rebase then re-run succeeds", async () => {
    const { p1, p2 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Conflict" }, admin);
    await addItems(site.id, rel.id, [{ page_id: p1.id, action: "publish" }, { page_id: p2.id, action: "unpublish" }], admin);
    await query("UPDATE pages SET title = 'changed', updated_at = NOW() WHERE id = $1", [p1.id]);
    await scheduleRelease(site.id, rel.id, future(), admin);
    const res = await executeRelease(rel.id, { source: "scheduler" });
    assert.equal(res.ok, false);
    assert.ok(res.conflicts.length >= 1);
    const relRow = (await query("SELECT status, error FROM releases WHERE id = $1", [rel.id])).rows[0];
    assert.equal(relRow.status, "failed");
    assert.equal(relRow.error, "conflicts");
    const st = (await query("SELECT id, published FROM pages WHERE id = ANY($1::int[])", [[p1.id, p2.id]])).rows;
    assert.equal(st.find((r) => r.id === p1.id).published, false);
    assert.equal(st.find((r) => r.id === p2.id).published, true);

    await assert.rejects(rebaseRelease(site.id, rel.id, collab), (e) => e.code === "FORBIDDEN");
    await rebaseRelease(site.id, rel.id, admin);
    assert.equal((await query("SELECT status FROM releases WHERE id = $1", [rel.id])).rows[0].status, "draft");
    await scheduleRelease(site.id, rel.id, future(), admin);
    const res2 = await executeRelease(rel.id, { source: "scheduler" });
    assert.equal(res2.ok, true);
    assert.equal((await query("SELECT status FROM releases WHERE id = $1", [rel.id])).rows[0].status, "done");
  });

  test("(7) manual force, workflow not_approved, FORBIDDEN for collaboratore", async () => {
    // Sito dedicato: la cache dei setting blog e' per sito e non interferisce con gli altri test.
    const s2 = await createTestSite("Workflow");
    const a2 = await createTestUser(s2.id, "admin");
    const c2 = await createTestUser(s2.id, "collaboratore");
    await query("INSERT INTO settings (site_id, key, value) VALUES ($1, 'editorial_workflow_enabled', '1')", [s2.id]);
    const p1 = await makePage(s2.id, { published: false });
    const rel = await createRelease(s2.id, { name: "Manual" }, a2);
    await addItems(s2.id, rel.id, [{ page_id: p1.id, action: "publish" }], a2);
    await query("UPDATE pages SET updated_at = NOW() WHERE id = $1", [p1.id]);

    await assert.rejects(executeRelease(rel.id, { source: "manual", user: c2 }), (e) => e.code === "FORBIDDEN");

    // page_changed + force: passa; ma not_approved (workflow ON, pagina non approvata) blocca comunque.
    const r1 = await executeRelease(rel.id, { source: "manual", user: a2, force: true });
    assert.equal(r1.ok, false);
    assert.ok(r1.conflicts.some((c) => c.conflicts.includes("not_approved")));
    assert.equal((await query("SELECT published FROM pages WHERE id = $1", [p1.id])).rows[0].published, false);

    await rebaseRelease(s2.id, rel.id, a2);
    await query("UPDATE pages SET editorial_status = 'approved' WHERE id = $1", [p1.id]);
    const r2 = await executeRelease(rel.id, { source: "manual", user: a2, force: true });
    assert.equal(r2.ok, true);
    assert.equal((await query("SELECT published FROM pages WHERE id = $1", [p1.id])).rows[0].published, true);
  });

  test("(8) concurrent claim: exactly one execution", async () => {
    const { p1 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Race" }, admin);
    await addItems(site.id, rel.id, [{ page_id: p1.id, action: "publish" }], admin);
    await scheduleRelease(site.id, rel.id, future(), admin);
    const [a, b] = await Promise.all([
      executeRelease(rel.id, { source: "scheduler" }),
      executeRelease(rel.id, { source: "scheduler" }),
    ]);
    const oks = [a, b].filter((r) => r.ok === true).length;
    const skipped = [a, b].filter((r) => r.skipped === true).length;
    assert.equal(oks, 1);
    assert.equal(skipped, 1);
  });

  test("(9) cancel by creator; cancel of done is INVALID_STATE", async () => {
    const { p1 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Cancel" }, collab);
    await addItems(site.id, rel.id, [{ page_id: p1.id, action: "publish" }], admin);
    const c = await cancelRelease(site.id, rel.id, collab);
    assert.equal(c.status, "cancelled");

    const { p1: q1 } = await mkPages();
    const rel2 = await createRelease(site.id, { name: "Done" }, admin);
    await addItems(site.id, rel2.id, [{ page_id: q1.id, action: "publish" }], admin);
    await scheduleRelease(site.id, rel2.id, future(), admin);
    await executeRelease(rel2.id, { source: "scheduler" });
    await assert.rejects(cancelRelease(site.id, rel2.id, admin), (e) => e.code === "INVALID_STATE");
  });

  test("(10) publish clears publish_at and expired unpublish_at, keeps future unpublish_at", async () => {
    const pExpired = await makePage(site.id, { published: false });
    const pFuture = await makePage(site.id, { published: false });
    await query("UPDATE pages SET publish_at = $2, unpublish_at = $3 WHERE id = $1", [pExpired.id, past(), past()]);
    await query("UPDATE pages SET publish_at = $2, unpublish_at = $3 WHERE id = $1", [pFuture.id, past(), future(7200_000)]);
    const rel = await createRelease(site.id, { name: "Dates" }, admin);
    await addItems(site.id, rel.id, [{ page_id: pExpired.id, action: "publish" }, { page_id: pFuture.id, action: "publish" }], admin);
    await scheduleRelease(site.id, rel.id, future(), admin);
    const res = await executeRelease(rel.id, { source: "scheduler" });
    assert.equal(res.ok, true);
    const e1 = (await query("SELECT published, publish_at, unpublish_at FROM pages WHERE id = $1", [pExpired.id])).rows[0];
    assert.equal(e1.published, true);
    assert.equal(e1.publish_at, null);
    assert.equal(e1.unpublish_at, null);
    const f1 = (await query("SELECT published, publish_at, unpublish_at FROM pages WHERE id = $1", [pFuture.id])).rows[0];
    assert.equal(f1.publish_at, null);
    assert.ok(f1.unpublish_at instanceof Date && f1.unpublish_at.getTime() > Date.now());
  });

  test("(11) mapReleaseError maps known codes and ignores unknown", () => {
    const t = (k) => k;
    const m = mapReleaseError(Object.assign(new Error("FORBIDDEN"), { code: "FORBIDDEN" }), t);
    assert.equal(m.status, 403);
    assert.equal(m.body.code, "forbidden");
    const pn = mapReleaseError(Object.assign(new Error("x"), { code: "PAGE_NOT_IN_SITE", page_ids: [5] }), t);
    assert.deepEqual(pn.body.page_ids, [5]);
    assert.equal(mapReleaseError(new Error("boom"), t), null);
  });

  test("(12) persistent failure ends in failed (not retried forever)", async () => {
    const { p1 } = await mkPages();
    const rel = await createRelease(site.id, { name: "Broken" }, admin);
    await addItems(site.id, rel.id, [{ page_id: p1.id, action: "publish" }], admin);
    await scheduleRelease(site.id, rel.id, future(), admin);
    const cname = `zz_rel_${rel.id}`;
    await query(`ALTER TABLE page_versions ADD CONSTRAINT ${cname} CHECK (label IS DISTINCT FROM 'release-${rel.id}')`);
    try {
      const res = await executeRelease(rel.id, { source: "scheduler" });
      assert.equal(res.ok, false);
      const row = (await query("SELECT status FROM releases WHERE id = $1", [rel.id])).rows[0];
      assert.equal(row.status, "failed");
      const again = await executeRelease(rel.id, { source: "scheduler" });
      assert.equal(again.skipped, true);
      assert.equal((await query("SELECT published FROM pages WHERE id = $1", [p1.id])).rows[0].published, false);
    } finally {
      await query(`ALTER TABLE page_versions DROP CONSTRAINT IF EXISTS ${cname}`);
    }
  });
});
