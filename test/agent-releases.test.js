import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { createRelease } from "../src/services/releases.js";
import agentRouter from "../src/routes/agent.js";
import { makePage } from "./ext-helpers.js";

describe("agent: releases routes", () => {
  let site, otherSite, admin, collab, otherAdmin;
  let adminTok, collabTok, readTok, otherTok;
  let server, baseUrl;
  let p1, p2, p3, pForeign;
  const base = () => `/api/agent/sites/${site.id}/releases`;

  before(async () => {
    site = await createTestSite("Releases Site");
    otherSite = await createTestSite("Releases Other Site");
    admin = await createTestUser(site.id, "admin");
    collab = await createTestUser(site.id, "collaboratore");
    otherAdmin = await createTestUser(otherSite.id, "admin");
    adminTok = (await createApiToken(admin.id, "rel admin", 30, ["read", "write"])).token;
    collabTok = (await createApiToken(collab.id, "rel collab", 30, ["read", "write"])).token;
    readTok = (await createApiToken(admin.id, "rel read", 30, ["read"])).token;
    otherTok = (await createApiToken(otherAdmin.id, "rel other", 30, ["read", "write"])).token;

    p1 = (await makePage(site.id, { published: false })).id;
    p2 = (await makePage(site.id, { published: false })).id;
    p3 = (await makePage(site.id, { published: false })).id;
    pForeign = (await makePage(otherSite.id, { published: false })).id;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  const hdr = (tok, json = true) => ({ Authorization: `Bearer ${tok}`, ...(json ? { "Content-Type": "application/json" } : {}) });
  async function call(method, path, tok, body) {
    const r = await fetch(baseUrl + path, { method, headers: hdr(tok, body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, json };
  }
  async function newRelease(name, items) {
    const r = await call("POST", base(), adminTok, { name, items });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.release;
  }
  const pageRow = async (id) => (await query("SELECT published FROM pages WHERE id = $1", [id])).rows[0];

  test("lifecycle: create with items -> preview -> schedule -> GET scheduled -> cancel", async () => {
    const rel = await newRelease("Lifecycle", [{ page_id: p1, action: "publish" }]);
    assert.equal(rel.status, "draft");

    const prev = await call("GET", `${base()}/${rel.id}/preview`, adminTok);
    assert.equal(prev.status, 200);
    assert.ok(Array.isArray(prev.json.items));

    const when = new Date(Date.now() + 3600 * 1000).toISOString();
    const sch = await call("POST", `${base()}/${rel.id}/schedule`, adminTok, { scheduled_at: when });
    assert.equal(sch.status, 200, JSON.stringify(sch.json));

    const got = await call("GET", `${base()}/${rel.id}`, adminTok);
    assert.equal(got.status, 200);
    assert.equal(got.json.release.status, "scheduled");

    const can = await call("POST", `${base()}/${rel.id}/cancel`, adminTok, {});
    assert.equal(can.status, 200, JSON.stringify(can.json));
    assert.equal(can.json.release.status, "cancelled");
  });

  test("manual run by admin publishes pages and returns ok/changed", async () => {
    const rel = await newRelease("Run", [
      { page_id: p2, action: "publish" },
      { page_id: p3, action: "publish" },
    ]);
    const r = await call("POST", `${base()}/${rel.id}/run`, adminTok, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.changed, 2);
    assert.equal((await pageRow(p2)).published, true);
    assert.equal((await pageRow(p3)).published, true);
    await query("UPDATE pages SET published = false WHERE id = ANY($1)", [[p2, p3]]);
  });

  test("run by collaboratore -> 403 forbidden", async () => {
    const rel = await newRelease("Run forbidden", [{ page_id: p1, action: "publish" }]);
    const r = await call("POST", `${base()}/${rel.id}/run`, collabTok, {});
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "forbidden");
  });

  test("schedule in the past -> 400 schedule_past", async () => {
    const rel = await newRelease("Past", [{ page_id: p1, action: "publish" }]);
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const r = await call("POST", `${base()}/${rel.id}/schedule`, adminTok, { scheduled_at: past });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "schedule_past");
  });

  test("schedule body without scheduled_at -> 400 validation_failed", async () => {
    const rel = await newRelease("No date", [{ page_id: p1, action: "publish" }]);
    const r = await call("POST", `${base()}/${rel.id}/schedule`, adminTok, {});
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "validation_failed");
  });

  test("adding a page of another site -> 400 page_not_in_site", async () => {
    const rel = await newRelease("Foreign", [{ page_id: p1, action: "publish" }]);
    const r = await call("POST", `${base()}/${rel.id}/items`, adminTok, { items: [{ page_id: pForeign, action: "publish" }] });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "page_not_in_site");
  });

  test("conflict flow: page changed -> run 409 conflicts -> rebase 200 -> run 200", async () => {
    const pc = (await makePage(site.id, { published: false })).id;
    const rel = await newRelease("Conflict", [{ page_id: pc, action: "publish" }]);
    // modifica della pagina dopo l'aggiunta alla release => base_updated_at non piu' coerente
    await query("UPDATE pages SET updated_at = NOW() + interval '1 minute' WHERE id = $1", [pc]);

    const r1 = await call("POST", `${base()}/${rel.id}/run`, adminTok, {});
    assert.equal(r1.status, 409, JSON.stringify(r1.json));
    assert.equal(r1.json.code, "conflicts");
    assert.ok(Array.isArray(r1.json.conflicts) && r1.json.conflicts.length >= 1);

    const rb = await call("POST", `${base()}/${rel.id}/rebase`, adminTok, {});
    assert.equal(rb.status, 200, JSON.stringify(rb.json));

    const r2 = await call("POST", `${base()}/${rel.id}/run`, adminTok, {});
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.equal(r2.json.ok, true);
  });

  test("release id of another site with a user of this site -> 404 release_not_found", async () => {
    const foreignRel = await createRelease(otherSite.id, { name: "Other site release" }, { id: otherAdmin.id });
    const r = await call("GET", `${base()}/${foreignRel.id}`, adminTok);
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "release_not_found");
  });

  test("read-only token on POST/PUT/DELETE -> 403 token_scope_required", async () => {
    const rel = await newRelease("Scope", [{ page_id: p1, action: "publish" }]);
    const reqs = [
      ["POST", base(), { name: "x" }],
      ["PUT", `${base()}/${rel.id}`, { name: "y" }],
      ["DELETE", `${base()}/${rel.id}`, undefined],
    ];
    for (const [m, p, b] of reqs) {
      const r = await call(m, p, readTok, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.json.error, "token_scope_required", `${m} ${p}`);
    }
  });

  test("cross-site user -> 403", async () => {
    const r = await call("GET", base(), otherTok);
    assert.equal(r.status, 403);
  });

  test("GET /releases/0 -> 400 invalid_id", async () => {
    const r = await call("GET", `${base()}/0`, adminTok);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "invalid_id");
  });
});
