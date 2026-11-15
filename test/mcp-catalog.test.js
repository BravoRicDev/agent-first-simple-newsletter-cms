import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import mcpRouter from "../src/routes/mcp.js";
import { discoverTools } from "../src/services/mcp-tools.js";
import { buildCatalog, NAV_NAMES } from "../src/services/mcp-tree.js";

// Server MCP: albero di navigazione (6 tool in tools/list), tool diretti
// ancora chiamabili per nome, errori che rimandano alla lista, hardening.
// Il proxy interno chiama http://127.0.0.1:<config.port> (app reale del
// container, stesso DB): le chiamate dirette qui sotto la attraversano.
describe("MCP: albero di navigazione + tool diretti + errori guidati", () => {
  let site, rwToken, roToken, server, baseUrl;

  before(async () => {
    site = await createTestSite("MCP Catalog");
    const superadmin = await createTestUser(site.id, "superadmin");
    rwToken = (await createApiToken(superadmin.id, "mcp rw", 30, ["read", "write"])).token;
    roToken = (await createApiToken(superadmin.id, "mcp ro", 30, ["read"])).token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; res.locals.lang = "en"; next(); });
    app.use(agentRouter);
    app.use(mcpRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });

  let rpcId = 0;
  async function rpc(token, method, params, { query = "", raw } = {}) {
    const res = await fetch(`${baseUrl}/api/mcp${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(raw ?? { jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await res.text();
    let body;
    const m = text.match(/^data: (.*)$/m);
    try { body = JSON.parse(m ? m[1] : text); } catch { body = { _raw: text }; }
    return { status: res.status, body };
  }
  const call = (token, name, args) => rpc(token, "tools/call", { name, arguments: args });
  const payload = (r) => {
    const text = r.body.result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };

  test("catalogo: nomi tool unici", () => {
    const tools = discoverTools("en");
    const seen = new Set();
    for (const t of tools) {
      assert.ok(!seen.has(t.name), `nome duplicato: ${t.name}`);
      seen.add(t.name);
    }
    assert.ok(tools.length > 300);
  });

  test("catalogo: ogni tool ha categoria e area (nessuno in 'other')", () => {
    const cat = buildCatalog(discoverTools("en"));
    const orphans = [...cat.byName.values()].filter((t) => !t.category || t.area === "other").map((t) => `${t.name} (${t.category})`);
    assert.deepEqual(orphans, [], `tool senza area: ${orphans.join(", ")}`);
  });

  test("catalogo: nessun tool generico per le route recenti (categories, blog-settings, homepage-sections)", () => {
    const tools = discoverTools("en");
    for (const prefix of ["/api/agent/sites/:siteId/categories", "/api/agent/sites/:siteId/blog-settings", "/api/agent/sites/:siteId/homepage-sections"]) {
      const generic = tools.filter((t) => t.path.startsWith(prefix) && !t.enriched).map((t) => `${t.method} ${t.path}`);
      assert.deepEqual(generic, []);
    }
  });

  test("tools/list: solo i 6 tool di navigazione", async () => {
    const r = await rpc(rwToken, "tools/list", {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.result.tools.map((t) => t.name).sort(), [...NAV_NAMES].sort());
  });

  test("tools/list?tools=all: elenco piatto completo con annotazioni", async () => {
    const r = await rpc(rwToken, "tools/list", {}, { query: "?tools=all" });
    const tools = r.body.result.tools;
    assert.ok(tools.length > 300);
    const del = tools.find((t) => t.name === "pages_delete");
    assert.equal(del?.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "pages_list").annotations.readOnlyHint, true);
  });

  test("tools_tree → tools_in_category → tools_describe", async () => {
    const tree = payload(await call(rwToken, "tools_tree", {}));
    assert.ok(tree.areas.length >= 4);
    const pagesCat = tree.areas.flatMap((a) => a.categories).find((c) => c.category === "pages");
    assert.ok(pagesCat && pagesCat.tools > 10);

    const list = payload(await call(rwToken, "tools_in_category", { category: "pages" }));
    assert.ok(list.tools.some((t) => t.name === "pages_list" && t.read_only === true));

    const d = payload(await call(rwToken, "tools_describe", { name: "pages_list" }));
    assert.equal(d.method, "GET");
    assert.ok(d.input_schema.properties.site_id);
  });

  test("tool diretto legacy: pages_list funziona come prima", async () => {
    const r = await call(rwToken, "pages_list", { site_id: site.id });
    assert.notEqual(r.body.result.isError, true, JSON.stringify(r.body));
  });

  test("tools_run_read esegue una lettura e rifiuta una scrittura", async () => {
    const ok = await call(rwToken, "tools_run_read", { name: "pages_list", args: { site_id: site.id } });
    assert.notEqual(ok.body.result.isError, true);
    const ko = await call(rwToken, "tools_run_read", { name: "pages_delete", args: { site_id: site.id, page_id: 1 } });
    assert.equal(ko.body.result.isError, true);
    assert.match(ko.body.result.content[0].text, /tools_run/);
  });

  test("tool inesistente: errore con suggerimenti e rimando alla lista", async () => {
    const r = await call(rwToken, "pages_lst", { site_id: site.id });
    assert.equal(r.body.result.isError, true);
    const text = r.body.result.content[0].text;
    assert.match(text, /Did you mean: .*pages_list/);
    assert.match(text, /tools_tree/);
  });

  test("tool inesistente via proxy tools_run: stesso errore guidato", async () => {
    const r = await call(rwToken, "tools_run", { name: "zzz_nope", args: {} });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /tools_tree/);
  });

  test("argomenti non validi: errore con rimando a tools_describe", async () => {
    const r = await call(rwToken, "pages_list", { site_id: "abc" });
    assert.equal(r.body.result.isError, true);
    const text = r.body.result.content[0].text;
    assert.match(text, /site_id/);
    assert.match(text, /tools_describe/);
  });

  test("categoria sconosciuta: elenca le categorie valide", async () => {
    const r = await call(rwToken, "tools_in_category", { category: "nope" });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /pages/);
  });

  test("batch JSON-RPC rifiutato con -32600", async () => {
    const r = await rpc(rwToken, null, null, { raw: [{ jsonrpc: "2.0", id: 1, method: "tools/list" }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, -32600);
  });

  test("token read-only: la scrittura via tools_run è bloccata dal gate scope", async () => {
    const r = await call(roToken, "tools_run", { name: "pages_create", args: { site_id: site.id, url_path: "/mcp-ro", title: "x" } });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /token_scope_required/);
  });

  test("senza token: 401, non redirect", async () => {
    const res = await fetch(`${baseUrl}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}", redirect: "manual" });
    assert.equal(res.status, 401);
  });
});
