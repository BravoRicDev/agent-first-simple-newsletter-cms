import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { startApp, httpReq, apiToken, makePage, noSmtp } from "./ext-helpers.js";
import { query } from "../src/db.js";
import { setBlogConfig } from "../src/services/blog-settings.js";
import { transition } from "../src/services/editorial.js";
import agentRouter from "../src/routes/agent.js";

noSmtp();

let site, site2, admin, collab, admin2, app;
let tAdmin, tCollab, tCollabRead, tAdmin2;

function call(method, path, token, body) {
  return httpReq(app.baseUrl, path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
}

async function fetchPage(id) {
  return (await query("SELECT * FROM pages WHERE id = $1", [id])).rows[0];
}

before(async () => {
  site = await createTestSite("Agent Editorial");
  site2 = await createTestSite("Agent Editorial Other");
  admin = await createTestUser(site.id, "admin");
  collab = await createTestUser(site.id, "collaboratore");
  admin2 = await createTestUser(site2.id, "admin");
  await setBlogConfig(site.id, { editorial_workflow_enabled: "1" });
  tAdmin = await apiToken(admin.id);
  tCollab = await apiToken(collab.id);
  tCollabRead = await apiToken(collab.id, ["read"]);
  tAdmin2 = await apiToken(admin2.id);
  app = await startApp({ routers: [agentRouter] });
});

after(async () => {
  app.close();
  await closeDb();
});

test("full cycle: collaboratore submits, admin approves, admin publishes", async () => {
  const p = await makePage(site.id, { published: false });
  const s = await call("POST", `/api/agent/sites/${site.id}/pages/${p.id}/editorial/submit`, tCollab, {});
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json().to, "in_review");

  const a = await call("POST", `/api/agent/sites/${site.id}/pages/${p.id}/editorial/approve`, tAdmin, {});
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json().to, "approved");

  const pub = await call("POST", `/api/agent/sites/${site.id}/pages/${p.id}/editorial/publish`, tAdmin, {});
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json().page.published, true);
  assert.equal(pub.json().page.editorial_status, "published");

  const row = await fetchPage(p.id);
  assert.equal(row.published, true);
  assert.equal(row.editorial_status, "published");
});

test("read-only token POST is refused with 403 token_scope_required", async () => {
  const p = await makePage(site.id, { published: false });
  const r = await call("POST", `/api/agent/sites/${site.id}/pages/${p.id}/editorial/submit`, tCollabRead, {});
  assert.equal(r.status, 403);
  assert.equal(r.json().error, "token_scope_required");
  assert.notEqual((await fetchPage(p.id)).editorial_status, "in_review");
});

test("GET editorial: collaboratore sees withdraw on in_review page, not approve", async () => {
  const p = await makePage(site.id, { published: false });
  await transition(site.id, p.id, "submit", { id: collab.id, email: collab.email, role: "collaboratore" });
  const r = await call("GET", `/api/agent/sites/${site.id}/pages/${p.id}/editorial`, tCollab);
  assert.equal(r.status, 200, r.text);
  const body = r.json();
  assert.equal(body.enabled, true);
  assert.equal(body.status, "in_review");
  assert.ok(body.allowed_actions.includes("withdraw"));
  assert.ok(!body.allowed_actions.includes("approve"));
  assert.ok(Array.isArray(body.history));
});

test("invalid action returns 400 invalid_action", async () => {
  const p = await makePage(site.id, { published: false });
  const r = await call("POST", `/api/agent/sites/${site.id}/pages/${p.id}/editorial/foo`, tAdmin, {});
  assert.equal(r.status, 400);
  assert.equal(r.json().error, "invalid_action");
});

test("cross-site request returns 403", async () => {
  const r = await call("GET", `/api/agent/sites/${site.id}/editorial/queue`, tAdmin2);
  assert.equal(r.status, 403);
});

test("queue lists only in_review pages by default, approved with ?status=approved", async () => {
  const pIn = await makePage(site.id, { published: false });
  await transition(site.id, pIn.id, "submit", { id: collab.id, email: collab.email, role: "collaboratore" });
  const pAp = await makePage(site.id, { published: false });
  await transition(site.id, pAp.id, "submit", { id: collab.id, email: collab.email, role: "collaboratore" });
  await transition(site.id, pAp.id, "approve", { id: admin.id, email: admin.email, role: "admin" });

  const def = await call("GET", `/api/agent/sites/${site.id}/editorial/queue`, tAdmin);
  assert.equal(def.status, 200, def.text);
  const defBody = def.json();
  assert.equal(defBody.status, "in_review");
  assert.equal(defBody.enabled, true);
  const defIds = defBody.items.map((i) => i.id);
  assert.ok(defIds.includes(pIn.id));
  assert.ok(!defIds.includes(pAp.id));
  assert.ok(defBody.items.every((i) => i.editorial_status === "in_review"));

  const ap = await call("GET", `/api/agent/sites/${site.id}/editorial/queue?status=approved`, tAdmin);
  assert.equal(ap.status, 200, ap.text);
  const apBody = ap.json();
  assert.equal(apBody.status, "approved");
  const apIds = apBody.items.map((i) => i.id);
  assert.ok(apIds.includes(pAp.id));
  assert.ok(!apIds.includes(pIn.id));
  assert.ok(apBody.items.every((i) => i.editorial_status === "approved"));
});

test("workflow disabled: POST returns 409 workflow_disabled", async () => {
  const p = await makePage(site.id, { published: false });
  await setBlogConfig(site.id, { editorial_workflow_enabled: "0" });
  try {
    const r = await call("POST", `/api/agent/sites/${site.id}/pages/${p.id}/editorial/submit`, tCollab, {});
    assert.equal(r.status, 409);
    assert.equal(r.json().error, "workflow_disabled");
  } finally {
    await setBlogConfig(site.id, { editorial_workflow_enabled: "1" });
  }
});

test("reject without comment returns 400 comment_required", async () => {
  const p = await makePage(site.id, { published: false });
  await transition(site.id, p.id, "submit", { id: collab.id, email: collab.email, role: "collaboratore" });
  const r = await call("POST", `/api/agent/sites/${site.id}/pages/${p.id}/editorial/reject`, tAdmin, {});
  assert.equal(r.status, 400);
  assert.equal(r.json().error, "comment_required");
  assert.equal((await fetchPage(p.id)).editorial_status, "in_review");
});

test("pageId=0 returns 400 invalid_id", async () => {
  const r = await call("GET", `/api/agent/sites/${site.id}/pages/0/editorial`, tAdmin);
  assert.equal(r.status, 400);
  assert.equal(r.json().error, "invalid_id");
});
