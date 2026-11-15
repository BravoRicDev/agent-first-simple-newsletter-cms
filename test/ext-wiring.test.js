import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { closeDb } from "./helpers.js";
import { discoverTools } from "../src/services/mcp-tools.js";
import { buildCatalog } from "../src/services/mcp-tree.js";

// Audit di cablaggio: nessuno stub residuo, tool arricchiti, router/guard montati,
// catalogo senza area "other", nomi unici, migrazioni 161..167 presenti.
const root = new URL("../", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), "utf8");

const STUB_FILES = [
  "src/routes/agent-versions.js",
  "src/routes/agent-openapi.js",
  "src/routes/agent-search.js",
  "src/routes/agent-editorial.js",
  "src/routes/agent-releases.js",
  "src/routes/agent-media-variants.js",
  "src/routes/agent-feeds.js",
  "src/routes/feed-public.js",
  "src/routes/search-public.js",
  "src/routes/image-transform.js",
  "src/routes/auth-mfa.js",
  "src/routes/auth-oidc.js",
  "src/routes/admin-editorial.js",
  "src/routes/admin-releases.js",
  "src/routes/admin-security.js",
  "src/middleware/editorial-guard.js",
  "src/middleware/mfa-enroll-guard.js",
  "src/services/mcp-meta-unpublish.js",
  "src/services/mcp-meta-versions.js",
  "src/services/mcp-meta-openapi.js",
  "src/services/mcp-meta-search.js",
  "src/services/mcp-meta-editorial.js",
  "src/services/mcp-meta-releases.js",
  "src/services/mcp-meta-media-variants.js",
  "src/services/mcp-meta-feeds.js",
  "src/services/scheduled-unpublish.js",
  "src/services/scheduled-releases.js",
  "src/services/scheduled-media-variants.js",
];

const ENRICHED_TOOLS = [
  "pages_version_get", "pages_version_diff", "pages_version_checkpoint", "pages_restore_version",
  "agent_openapi_get", "feeds_list", "search_pages", "search_reindex", "editorial_queue",
  "pages_editorial_get", "pages_editorial_transition", "releases_list", "releases_create",
  "releases_get", "releases_update", "releases_delete", "releases_items_add", "releases_item_remove",
  "releases_preview", "releases_schedule", "releases_cancel", "releases_rebase", "releases_run",
  "media_variants_get", "media_focal_set", "media_variants_regenerate", "pages_create",
  "pages_replace", "blog_settings_update",
];

const NEW_ROUTERS = ["feedPublicRoutes", "searchPublicRoutes", "imageTransformRoutes", "authMfaRoutes",
  "authOidcRoutes", "adminEditorialRoutes", "adminReleasesRoutes", "adminSecurityRoutes"];

const AGENT_REGISTRARS = ["agent-versions", "agent-openapi", "agent-search", "agent-editorial",
  "agent-releases", "agent-media-variants", "agent-feeds"];

describe("ext wiring audit", () => {
  const tools = discoverTools("en");
  const byName = new Map(tools.map((t) => [t.name, t]));

  test("no stub file remains (no STUB: marker)", () => {
    for (const rel of STUB_FILES) {
      const text = read(rel);
      assert.ok(!text.includes("STUB:"), `stub residuo in ${rel}`);
    }
  });

  test("every new tool exists with enriched meta", () => {
    for (const name of ENRICHED_TOOLS) {
      const tool = byName.get(name);
      assert.ok(tool, `tool mancante: ${name}`);
      assert.equal(tool.enriched, true, `tool non arricchito: ${name}`);
    }
  });

  test("catalog has no tool in area 'other'", () => {
    const cat = buildCatalog(tools);
    const others = [...cat.byName.values()].filter((t) => t.area === "other").map((t) => `${t.name} (${t.path})`);
    assert.deepEqual(others, [], `tool in area other: ${others.join(", ")}`);
  });

  test("tool names are unique", () => {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "nomi tool duplicati");
  });

  test("new tool input schemas carry the new fields", () => {
    assert.ok(byName.get("pages_create"), "pages_create mancante");
    assert.ok("unpublish_at" in byName.get("pages_create").inputSchema, "pages_create senza unpublish_at");
    assert.ok("post_type" in byName.get("pages_create").inputSchema, "pages_create senza post_type");
    assert.ok(byName.get("blog_settings_update"), "blog_settings_update mancante");
    assert.ok("feed_enabled" in byName.get("blog_settings_update").inputSchema, "blog_settings_update senza feed_enabled");
  });

  test("src/index.js mounts new routers before the public catch-all and editorial guard before auth", () => {
    const index = read("src/index.js");
    const catchAll = index.indexOf("app.use(publicCatchAllRouter)");
    assert.ok(catchAll > 0, "app.use(publicCatchAllRouter) non trovato");
    for (const m of index.matchAll(/app\.use\((\w+Routes?)\)/g)) {
      if (m[1] === "publicCatchAllRouter") continue;
      assert.ok(m.index < catchAll, `${m[1]} montato dopo publicCatchAllRouter`);
    }
    for (const name of NEW_ROUTERS) {
      assert.ok(index.includes(`app.use(${name})`), `router non montato: ${name}`);
    }
    const guard = index.indexOf("app.use(editorialGuard)");
    assert.ok(guard > 0, "app.use(editorialGuard) non trovato");
    assert.ok(guard < index.indexOf("app.use(authRoutes)"), "editorialGuard non prima di authRoutes");
    assert.ok(index.includes("app.use(\"/admin\", mfaEnrollGuard)") || index.includes("app.use(mfaEnrollGuard)"),
      "mfaEnrollGuard non montato");
  });

  test("scheduler runs the new steps after publishDuePages()", () => {
    const sched = read("src/services/scheduler.js");
    const base = sched.indexOf("await publishDuePages();");
    assert.ok(base > 0, "await publishDuePages(); non trovato");
    for (const fn of ["runUnpublishDue", "runReleasesDue", "runMediaVariantsBackfill"]) {
      const idx = sched.indexOf(fn, base);
      assert.ok(idx > base, `${fn} non chiamato dopo publishDuePages()`);
    }
  });

  test("migrations 161..167 exist and numeric prefixes are unique", () => {
    const files = fs.readdirSync(new URL("db/", root));
    const nums = files.filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 3)));
    assert.equal(new Set(nums).size, nums.length, "prefissi migrazione duplicati");
    for (let n = 161; n <= 167; n++) {
      assert.ok(nums.includes(n), `migrazione ${n} mancante`);
    }
  });

  test("agent kit exists and every registrar of this plan imports agentRoute from it", () => {
    read("src/routes/agent-kit.js");
    // agent-openapi e' una route globale (non per sito): usa requireAgent + guardia del router, nessun canAccessSite.
    for (const f of AGENT_REGISTRARS.filter((x) => x !== "agent-openapi")) {
      assert.ok(read(`src/routes/${f}.js`).includes(`from "./agent-kit.js"`), `${f}.js non importa da agent-kit.js`);
    }
    assert.ok(read("src/routes/agent-openapi.js").includes("requireAgent"), "agent-openapi.js deve usare requireAgent");
  });

  test("v1 column design gone; page_search_index in migration 162; feed has no author_name", () => {
    const srcFiles = ["src/index.js"];
    const walk = (dir) => {
      for (const e of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
        const rel = `${dir}${e.name}`;
        if (e.isDirectory()) walk(`${rel}/`);
        else if (/\.js$/.test(e.name)) srcFiles.push(rel);
      }
    };
    walk("src/");
    for (const rel of srcFiles) {
      assert.ok(!read(rel).includes("search_tsv"), `search_tsv residuo in ${rel}`);
    }
    const mig = fs.readdirSync(new URL("db/", root)).find((f) => f.startsWith("162_"));
    assert.ok(mig && read(`db/${mig}`).includes("page_search_index"), "page_search_index assente in migrazione 162");
    assert.ok(!read("src/services/feed.js").includes("author_name"), "author_name presente in feed.js");
  });

  after(async () => {
    await closeDb();
  });
});
