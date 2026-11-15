import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { noSmtp, makePage } from "./ext-helpers.js";
import { query } from "../src/db.js";
import config from "../src/config.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import {
  transition, allowedActions, canPublish, canReview, listQueue, listReviews, mapEditorialError,
} from "../src/services/editorial.js";

noSmtp();

let site, admin, collab;
const t = (k) => k;

async function fetchPage(id) {
  return (await query("SELECT * FROM pages WHERE id = $1", [id])).rows[0];
}

before(async () => {
  site = await createTestSite("Editorial");
  admin = await createTestUser(site.id, "admin");
  collab = await createTestUser(site.id, "collaboratore");
  await setBlogConfig(site.id, { editorial_workflow_enabled: "1" });
});

after(async () => {
  await closeDb();
});

test("1 workflow disabled rejects transition", async () => {
  await setBlogConfig(site.id, { editorial_workflow_enabled: "0" });
  try {
    const p = await makePage(site.id, { published: false });
    await assert.rejects(transition(site.id, p.id, "submit", collab), (e) => e.code === "WORKFLOW_DISABLED");
  } finally {
    await setBlogConfig(site.id, { editorial_workflow_enabled: "1" });
  }
});

test("2 collaboratore submits draft to in_review, writes review row and audit", async () => {
  const p = await makePage(site.id, { published: false });
  const r = await transition(site.id, p.id, "submit", collab, { comment: "ok" });
  assert.equal(r.from, "draft");
  assert.equal(r.to, "in_review");
  assert.equal((await fetchPage(p.id)).editorial_status, "in_review");
  const reviews = (await query("SELECT id FROM page_reviews WHERE page_id = $1", [p.id])).rows;
  assert.ok(reviews.length >= 1);
  const audit = (await query("SELECT id FROM audit_log WHERE action = 'editorial_submit' AND entity_id = $1", [p.id])).rows;
  assert.ok(audit.length >= 1);
});

test("3 collaboratore cannot approve", async () => {
  const p = await makePage(site.id, { published: false });
  await transition(site.id, p.id, "submit", collab);
  await assert.rejects(transition(site.id, p.id, "approve", collab), (e) => e.code === "FORBIDDEN_ACTION");
});

test("4 admin approves; reject needs comment, then rejects with comment", async () => {
  const p = await makePage(site.id, { published: false });
  await transition(site.id, p.id, "submit", collab);
  const a = await transition(site.id, p.id, "approve", admin);
  assert.equal(a.to, "approved");
  assert.equal((await fetchPage(p.id)).editorial_status, "approved");

  const q = await makePage(site.id, { published: false });
  await transition(site.id, q.id, "submit", collab);
  await assert.rejects(transition(site.id, q.id, "reject", admin), (e) => e.code === "COMMENT_REQUIRED");
  const rj = await transition(site.id, q.id, "reject", admin, { comment: "da rivedere" });
  assert.equal(rj.to, "rejected");
  assert.equal((await fetchPage(q.id)).editorial_status, "rejected");
});

test("5 publish only from approved; article gets published_at and listing condition holds", async () => {
  const p = await makePage(site.id, { published: false, post_type: "article" });
  await transition(site.id, p.id, "submit", collab);
  await assert.rejects(transition(site.id, p.id, "publish", admin), (e) => e.code === "INVALID_TRANSITION" && e.from === "in_review");
  await transition(site.id, p.id, "approve", admin);
  await transition(site.id, p.id, "publish", admin);
  const row = await fetchPage(p.id);
  assert.equal(row.published, true);
  assert.equal(row.editorial_status, "published");
  assert.ok(row.published_at);
  const listing = (await query(
    "SELECT id FROM pages WHERE site_id = $1 AND post_type = 'article' AND published = true AND (unpublish_at IS NULL OR unpublish_at > NOW()) AND id = $2",
    [site.id, p.id])).rows;
  assert.equal(listing.length, 1);
});

test("6 unpublish sets published=false and status draft", async () => {
  const p = await makePage(site.id, { published: false });
  await transition(site.id, p.id, "submit", collab);
  await transition(site.id, p.id, "approve", admin);
  await transition(site.id, p.id, "publish", admin);
  await transition(site.id, p.id, "unpublish", admin);
  const row = await fetchPage(p.id);
  assert.equal(row.published, false);
  assert.equal(row.editorial_status, "draft");
});

test("7 trigger: content change resets approved; excerpt-only change does not", async () => {
  const p = await makePage(site.id, { published: false });
  await query("UPDATE pages SET editorial_status = 'approved' WHERE id = $1", [p.id]);
  await query("UPDATE pages SET excerpt = 'nuovo' WHERE id = $1", [p.id]);
  assert.equal((await fetchPage(p.id)).editorial_status, "approved");
  await query("UPDATE pages SET content = 'x' WHERE id = $1", [p.id]);
  assert.equal((await fetchPage(p.id)).editorial_status, "draft");
});

test("8 custom role with pages.publish grants canPublish and canReview", async () => {
  const u = await createTestUser(site.id, "collaboratore");
  const plain = { ...u };
  assert.equal(await canPublish(plain, site.id), false);
  assert.equal(await canReview(plain, site.id), false);
  const role = (await query(
    `INSERT INTO custom_roles (site_id, name, permissions) VALUES (0, 'pub', '{"pages":["publish"]}') RETURNING id`)).rows[0];
  await query("UPDATE users SET custom_role_id = $1 WHERE id = $2", [role.id, u.id]);
  assert.equal(await canPublish(u, site.id), true);
  assert.equal(await canReview(u, site.id), true);
});

test("9 allowedActions for in_review page: admin vs collaboratore", async () => {
  const p = await makePage(site.id, { published: false });
  await transition(site.id, p.id, "submit", collab);
  const row = await fetchPage(p.id);
  const forAdmin = await allowedActions(row, admin, site.id);
  for (const a of ["approve", "reject", "withdraw"]) assert.ok(forAdmin.includes(a), `admin missing ${a}`);
  assert.deepEqual(await allowedActions(row, collab, site.id), ["withdraw"]);
});

test("10 listQueue filters by status; listReviews newest first", async () => {
  const p = await makePage(site.id, { published: false });
  await transition(site.id, p.id, "submit", collab);
  await transition(site.id, p.id, "reject", admin, { comment: "no" });
  const q = await listQueue(site.id, { status: "rejected" });
  assert.ok(q.some((r) => r.id === p.id));
  assert.ok(q.every((r) => r.editorial_status === "rejected"));
  const inReview = await listQueue(site.id, { status: "in_review" });
  assert.ok(!inReview.some((r) => r.id === p.id));
  const reviews = await listReviews(site.id, p.id);
  assert.equal(reviews[0].to_status, "rejected");
  assert.equal(reviews[reviews.length - 1].to_status, "in_review");
});

test("11 mapEditorialError maps codes", async () => {
  const c = mapEditorialError({ code: "COMMENT_REQUIRED" }, t);
  assert.equal(c.status, 400);
  assert.equal(c.body.error, "comment_required");
  assert.equal(c.body.message, "api.editorial.comment_required");
  const i = mapEditorialError({ code: "INVALID_TRANSITION", from: "in_review", action: "publish" }, t);
  assert.equal(i.status, 409);
  assert.equal(i.body.from, "in_review");
  assert.equal(mapEditorialError({ code: "SOMETHING_ELSE" }, t), null);
});

test("12 notify is fire-and-forget: transition resolves with SMTP configured", async () => {
  config.smtpHost = "smtp.invalid";
  try {
    const p = await makePage(site.id, { published: false, title: "<b>x</b>" });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000));
    const r = await Promise.race([transition(site.id, p.id, "submit", collab), timeout]);
    assert.equal(r.to, "in_review");
  } finally {
    config.smtpHost = "";
  }
});
