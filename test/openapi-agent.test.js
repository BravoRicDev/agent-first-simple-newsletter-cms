import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOpenApiDocument } from "../src/services/openapi-agent.js";

const { discoverTools } = await import("../src/services/mcp-tools.js");
const tree = await import("../src/services/mcp-tree.js");
const tools = discoverTools("en");
const helpers = { AREAS: tree.AREAS, categoryOf: tree.categoryOf, areaOfCategory: tree.areaOfCategory };
const doc = buildOpenApiDocument(tools, { helpers });

function allOps() {
  const out = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(item)) out.push({ p, m, op });
  }
  return out;
}

function walkRefs(node, acc = []) {
  if (Array.isArray(node)) node.forEach((n) => walkRefs(n, acc));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") acc.push(v);
      else walkRefs(v, acc);
    }
  }
  return acc;
}

describe("openapi-agent", () => {
  test("(1) openapi version 3.1.0", () => {
    assert.equal(doc.openapi, "3.1.0");
  });

  test("(2) operationIds equal tool names, no duplicates", () => {
    const ids = allOps().map((x) => x.op.operationId);
    assert.equal(ids.length, tools.length);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...new Set(ids)].sort(), tools.map((t) => t.name).sort());
  });

  test("(3) every path param has a required path parameter", () => {
    for (const { p, op } of allOps()) {
      const names = [...p.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
      for (const n of names) {
        assert.ok(op.parameters.some((x) => x.name === n && x.in === "path" && x.required === true), `${op.operationId} missing ${n}`);
      }
    }
  });

  test("(4) tags[0] is a known area id or other", () => {
    const known = new Set(doc.tags.map((t) => t.name));
    for (const { op } of allOps()) {
      assert.ok(known.has(op.tags[0]), `${op.operationId} tag ${op.tags[0]}`);
    }
  });

  test("(5) body rules for GET/DELETE and POST/PUT", () => {
    for (const { m, op } of allOps()) {
      if (m === "get" || m === "delete") assert.equal(op.requestBody, undefined, op.operationId);
    }
    for (const { m, op } of allOps()) {
      if ((m === "post" || m === "put") && op.operationId && !tools.find((t) => t.name === op.operationId)?.multipart) {
        const tool = tools.find((t) => t.name === op.operationId);
        if (tool?.enriched) {
          assert.equal(op.requestBody.content["application/json"].schema.type, "object", op.operationId);
        }
      }
    }
    const up = tools.find((t) => t.multipart);
    assert.ok(up, "multipart tool exists");
    const upOp = allOps().find((x) => x.op.operationId === up.name).op;
    assert.ok(upOp.requestBody.content["multipart/form-data"]);
  });

  test("(6) all $ref resolve under components", () => {
    for (const ref of walkRefs(doc)) {
      const parts = ref.replace(/^#\//, "").split("/");
      let cur = doc;
      for (const part of parts) {
        assert.ok(cur && typeof cur === "object" && part in cur, `unresolved ${ref}`);
        cur = cur[part];
      }
    }
  });

  test("(7) serializable, no undefined values", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
    const hasUndef = (v) => {
      if (v === undefined) return true;
      if (Array.isArray(v)) return v.some(hasUndef);
      if (v && typeof v === "object") return Object.values(v).some(hasUndef);
      return false;
    };
    assert.equal(hasUndef(doc), false);
  });

  test("(8) spot checks pages_get and pages_list", () => {
    const get = allOps().find((x) => x.op.operationId === "pages_get").op;
    const names = get.parameters.map((p) => p.name);
    assert.ok(names.includes("siteId") && names.includes("pageId"));
    const pagesGet = get.parameters.find((p) => p.name === "siteId");
    assert.equal(pagesGet["x-mcp-argument"], "site_id");
    assert.equal(get.parameters.find((p) => p.name === "pageId")["x-mcp-argument"], "page_id");
    const list = allOps().find((x) => x.op.operationId === "pages_list").op;
    const pt = list.parameters.find((p) => p.in === "query" && p.name === "post_type");
    assert.ok(pt, "post_type query param");
    assert.deepEqual(pt.schema.enum, ["page", "article"]);
  });

  test("(9) area filter crm returns only crm operations", () => {
    const crm = buildOpenApiDocument(tools, { area: "crm", helpers });
    const ops = Object.values(crm.paths).flatMap((item) => Object.values(item));
    assert.ok(ops.length > 0);
    for (const op of ops) assert.deepEqual(op.tags, ["crm"]);
  });

  test("(10) every path starts with /api/agent", () => {
    for (const p of Object.keys(doc.paths)) assert.ok(p.startsWith("/api/agent"), p);
  });
});
