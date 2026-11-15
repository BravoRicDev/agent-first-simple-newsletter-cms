import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { makeToolHandler } from "./mcp-tools.js";

// ─────────────────────────────────────────────────────────────────────────
// Albero di navigazione dei tool MCP: invece di ~385 tool piatti in
// tools/list, il server espone 6 tool di navigazione. Gli altri tool restano
// invocabili direttamente per nome (retrocompatibilità con agenti che li
// conoscono già) e tramite i proxy tools_run_read / tools_run.
//
// Categoria di un tool = primo segmento di path dopo /api/agent/ (o dopo
// sites/:siteId/), kebab -> snake. Le categorie sono raggruppate in aree.
// Un test blocca ogni tool che finisce nell'area "other".
// ─────────────────────────────────────────────────────────────────────────

export const AREAS = [
  { id: "content", en: "Content & site", it: "Contenuti e sito", categories: [
    "pages", "categories", "blog_settings", "homepage_sections", "snippets", "variables", "templates", "media",
    "redirects", "seo", "sitemap", "sites", "new_path", "deprecated_path", "validate_path", "rewrite",
    "export_static", "export_static_all", "deploy", "forms", "tracking", "tracked_links", "social_posts", "settings", "modules", "quizzes",
  ] },
  { id: "newsletter", en: "Newsletter & email", it: "Newsletter ed email", categories: [
    "newsletter", "email_templates", "email_stats", "reply_suggestions",
  ] },
  { id: "crm", en: "CRM & sales", it: "CRM e vendite", categories: [
    "contacts", "segments", "scoring_rules", "scoring_thresholds", "opportunities", "opportunities_stats", "quotes", "pipelines", "pipeline", "funnel",
    "conversations", "tasks", "recurring_tasks", "followup_rules", "followup_runs", "followup_check", "clients", "services_catalog",
    "calls", "call_summaries", "payment_links", "ingest", "data_import", "data_export", "import_jobs", "shifts", "operators_on_duty",
  ] },
  { id: "automation", en: "Agents & automation", it: "Agenti e automazione", categories: [
    "workflows", "agent_definitions", "agent_runtimes", "agent_runtime", "approvals", "sandbox", "sandbox_runs", "kb", "tick", "events", "webhooks",
    "webhook_events", "webhook_deliveries", "channel_limits", "channel_usage",
  ] },
  { id: "integrations", en: "Integrations", it: "Integrazioni", categories: [
    "oauth", "oauth_apps", "calendar_sync_configs", "calendars", "source_sync", "source_push", "satellites", "access_grants",
  ] },
  { id: "admin", en: "Admin, reports & system", it: "Amministrazione, report e sistema", categories: [
    "dashboard", "stats", "report_configs", "roles", "users", "me", "audit_log", "audit_events", "backup", "backup_jobs", "bug_reports",
    "changelog", "capabilities", "guide", "verify_token", "verify_otp", "refresh_token",
  ] },
];

const AREA_OF_CATEGORY = new Map();
for (const a of AREAS) for (const c of a.categories) AREA_OF_CATEGORY.set(c, a.id);

export function categoryOf(path) {
  const rest = path.replace(/^\/api\/agent\/?/, "").replace(/^sites\/:siteId\/?/, "");
  const seg = rest.split("/")[0] || "root";
  return seg.replace(/-/g, "_");
}

export function areaOfCategory(category) {
  return AREA_OF_CATEGORY.get(category) || "other";
}

export const NAV_NAMES = ["agent_guide", "tools_tree", "tools_in_category", "tools_describe", "tools_run_read", "tools_run"];

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// tools: output di discoverTools(lang). Aggiunge area/category/readOnly.
export function buildCatalog(tools) {
  const byName = new Map();
  const categories = new Map(); // category -> [tool]
  for (const t of tools) {
    const category = categoryOf(t.path);
    const entry = { ...t, category, area: areaOfCategory(category), readOnly: t.method === "GET" };
    byName.set(t.name, entry);
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(entry);
  }
  return { byName, categories };
}

export function suggestNames(catalog, name, max = 3) {
  const q = String(name || "").toLowerCase();
  const scored = [];
  for (const n of catalog.byName.keys()) {
    const lower = n.toLowerCase();
    let score = levenshtein(q, lower);
    if (lower.includes(q) || q.includes(lower)) score = Math.min(score, 2);
    scored.push([n, score]);
  }
  scored.sort((x, y) => x[1] - y[1]);
  return scored.slice(0, max).filter(([, s]) => s <= Math.max(6, Math.floor(q.length / 2))).map(([n]) => n);
}

function textResult(obj, isError = false) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }], isError };
}

const NAV_HINT = 'Call tools_tree to see the areas, tools_in_category {"category":"..."} to list the tools of a category, tools_describe {"name":"..."} for the input schema.';

export function unknownToolResult(catalog, name) {
  const sugg = suggestNames(catalog, name);
  return textResult(`Unknown tool "${name}". ${sugg.length ? `Did you mean: ${sugg.join(", ")}? ` : ""}${NAV_HINT}`, true);
}

function invalidArgsResult(name, issues) {
  const list = issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return textResult(`Invalid arguments for "${name}": ${list}. Call tools_describe {"name":"${name}"} to see the expected input schema.`, true);
}

function addHint(result, name) {
  if (!result?.isError) return result;
  const first = result.content?.[0];
  if (first?.type === "text" && /"(error|message)"/.test(first.text || "") && !/tools_describe/.test(first.text)) {
    return { ...result, content: [{ type: "text", text: `${first.text} (If unsure about the parameters, call tools_describe {"name":"${name}"}.)` }, ...result.content.slice(1)] };
  }
  return result;
}

// Esegue un tool del catalogo per nome: validazione args + proxy interno.
export async function executeTool(catalog, name, args, extra, { readOnlyOnly = false } = {}) {
  const tool = catalog.byName.get(name);
  if (!tool) return unknownToolResult(catalog, name);
  if (readOnlyOnly && !tool.readOnly) {
    return textResult(`Tool "${name}" is not read-only (${tool.method}). Use tools_run instead of tools_run_read.`, true);
  }
  const parsed = z.object(tool.inputSchema).passthrough().safeParse(args && typeof args === "object" ? args : {});
  if (!parsed.success) return invalidArgsResult(name, parsed.error.issues);
  return addHint(await makeToolHandler(tool)(parsed.data, extra), name);
}

export function annotationsFor(tool) {
  if (tool.method === "GET") return { readOnlyHint: true };
  if (tool.method === "DELETE") return { readOnlyHint: false, destructiveHint: true };
  return { readOnlyHint: false, destructiveHint: false };
}

export function schemaOf(tool) {
  return zodToJsonSchema(z.object(tool.inputSchema), { target: "jsonSchema7", $refStrategy: "none" });
}

const GUIDE = [
  "This MCP server exposes the whole CMS agent API through a navigable tree.",
  "1. tools_tree: list areas and categories (with tool counts).",
  '2. tools_in_category {"category":"pages"}: list the tools of a category.',
  '3. tools_describe {"name":"pages_list"}: get description, HTTP method and JSON input schema.',
  '4. tools_run_read {"name":"pages_list","args":{"site_id":1}}: run READ-ONLY tools (GET).',
  '5. tools_run {"name":"pages_create","args":{...}}: run any tool, including writes (needs a write-scope token).',
  "Most routes are per site: pass site_id (list sites with the sites tool). Tools you already know by name can still be called directly. If a call fails on parameters, run tools_describe first.",
].join("\n");

export function navigationTools(lang) {
  const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  return [
    { name: "agent_guide", description: "How to use this server: the discovery flow and conventions. Call first.", inputSchema: obj({}), annotations: { readOnlyHint: true } },
    { name: "tools_tree", description: "Lists areas and categories of tools with tool counts.", inputSchema: obj({}), annotations: { readOnlyHint: true } },
    { name: "tools_in_category", description: "Lists the tools of a category (name, method, read-only flag, short description).", inputSchema: obj({ category: { type: "string", description: 'Category id, e.g. "pages", or "area/category"' } }, ["category"]), annotations: { readOnlyHint: true } },
    { name: "tools_describe", description: "Describes one tool: description, HTTP method, read-only flag and JSON input schema.", inputSchema: obj({ name: { type: "string" } }, ["name"]), annotations: { readOnlyHint: true } },
    { name: "tools_run_read", description: "Runs a READ-ONLY tool (GET) by name. args = the tool input (see tools_describe).", inputSchema: obj({ name: { type: "string" }, args: { type: "object", additionalProperties: true } }, ["name"]), annotations: { readOnlyHint: true } },
    { name: "tools_run", description: "Runs any tool by name, including writes and deletes (requires a write-scope token for writes). args = the tool input (see tools_describe).", inputSchema: obj({ name: { type: "string" }, args: { type: "object", additionalProperties: true } }, ["name"]), annotations: { readOnlyHint: false, destructiveHint: true } },
  ];
}

export async function handleNavigation(catalog, lang, name, args, extra) {
  const a = args || {};
  const label = (o) => (lang === "it" ? o.it : o.en);
  switch (name) {
    case "agent_guide":
      return textResult(GUIDE);
    case "tools_tree": {
      const tree = AREAS.map((area) => ({
        area: area.id,
        title: label(area),
        categories: area.categories
          .filter((c) => catalog.categories.has(c))
          .map((c) => ({ category: c, tools: catalog.categories.get(c).length })),
      })).filter((x) => x.categories.length);
      const other = [...catalog.categories.keys()].filter((c) => areaOfCategory(c) === "other");
      if (other.length) tree.push({ area: "other", title: "Other", categories: other.map((c) => ({ category: c, tools: catalog.categories.get(c).length })) });
      return textResult({ areas: tree, next: 'Call tools_in_category {"category":"<category>"}' });
    }
    case "tools_in_category": {
      const raw = String(a.category || "");
      const id = raw.includes("/") ? raw.split("/")[1] : raw;
      const key = id.replace(/-/g, "_");
      const list = catalog.categories.get(key);
      if (!list) return textResult(`Unknown category "${raw}". Valid categories: ${[...catalog.categories.keys()].sort().join(", ")}. Call tools_tree for the grouped list.`, true);
      return textResult({
        category: key,
        tools: list.map((t) => ({ name: t.name, method: t.method, read_only: t.readOnly, description: String(t.description).slice(0, 120) })),
        next: 'Call tools_describe {"name":"<tool>"} for the input schema',
      });
    }
    case "tools_describe": {
      const tool = catalog.byName.get(String(a.name || ""));
      if (!tool) return unknownToolResult(catalog, a.name);
      return textResult({
        name: tool.name, method: tool.method, path: tool.path, area: tool.area, category: tool.category, read_only: tool.readOnly,
        description: tool.description, input_schema: schemaOf(tool),
        example_call: { name: tool.readOnly ? "tools_run_read" : "tools_run", arguments: { name: tool.name, args: {} } },
      });
    }
    case "tools_run_read":
      return executeTool(catalog, String(a.name || ""), a.args, extra, { readOnlyOnly: true });
    case "tools_run":
      return executeTool(catalog, String(a.name || ""), a.args, extra);
    default:
      return null;
  }
}
