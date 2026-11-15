import { Router } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAgent } from "./agent.js";
import { discoverTools } from "../services/mcp-tools.js";
import { buildCatalog, navigationTools, handleNavigation, executeTool, annotationsFor, schemaOf, NAV_NAMES } from "../services/mcp-tree.js";
import { logger } from "../services/logger.js";

const router = Router();

// Il set di tool è derivato dal router /api/agent reale (vedi mcp-tools.js)
// e non cambia a runtime, solo per lingua: catalogo + albero si costruiscono
// una volta per lingua e si riusano. Il Server MCP + transport sono ricreati
// per ogni richiesta (pattern stateless dell'SDK per Streamable HTTP).
//
// tools/list espone SOLO i 6 tool di navigazione (agent_guide, tools_tree,
// tools_in_category, tools_describe, tools_run_read, tools_run). Ogni tool
// "vecchio" resta chiamabile direttamente per nome (retrocompatibilità) e
// con ?tools=all tools/list torna l'elenco piatto completo.
const catalogByLang = new Map();
function getCatalog(lang) {
  if (!catalogByLang.has(lang)) {
    const tools = discoverTools(lang);
    const enriched = tools.filter((t) => t.enriched).length;
    logger.info(`MCP [${lang}]: ${tools.length} tool nel catalogo (${enriched} con schema arricchito, ${tools.length - enriched} generici)`);
    catalogByLang.set(lang, buildCatalog(tools));
  }
  return catalogByLang.get(lang);
}

function buildServer(lang, { flat = false } = {}) {
  const catalog = getCatalog(lang);
  const server = new Server({ name: "gestione-siti-agent", version: "2.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const nav = navigationTools(lang);
    if (!flat) return { tools: nav };
    const direct = [...catalog.byName.values()].map((t) => ({
      name: t.name, description: t.description, inputSchema: schemaOf(t), annotations: annotationsFor(t),
    }));
    return { tools: [...nav, ...direct] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const isNav = NAV_NAMES.includes(name);
    let result;
    try {
      result = isNav
        ? await handleNavigation(catalog, lang, name, args, extra)
        : await executeTool(catalog, name, args, extra);
    } catch (err) {
      logger.error(`MCP tool ${name}: ${err.message}`);
      result = { content: [{ type: "text", text: "Tool execution failed (details in server log)." }], isError: true };
    }
    logger.info(`MCP call user=${extra?.authInfo?.clientId ?? "?"} tool=${name} via=${isNav ? "nav" : "direct"} status=${result?.isError ? "error" : "ok"}`);
    return result;
  });
  return server;
}

// Se la richiesta porta un Bearer esplicito il cookie di sessione viene
// ignorato: requireAuth preferisce il cookie, ma il proxy interno inoltra
// l'header Authorization → identità validata e identità eseguita
// coinciderebbero solo per caso.
function preferBearerOverCookie(req, res, next) {
  if (/^Bearer\s+\S+$/i.test(req.headers.authorization || "") && req.cookies?.token) delete req.cookies.token;
  next();
}

function rejectBatch(req, res, next) {
  if (Array.isArray(req.body)) {
    return res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Batch requests are not supported: send one request per call" }, id: null });
  }
  next();
}

router.post("/api/mcp", preferBearerOverCookie, rejectBatch, requireAuth, requireAgent, async (req, res) => {
  try {
    req.auth = { token: "", clientId: String(req.user?.sub ?? ""), scopes: req.user?.scopes || [] };
    const server = buildServer(res.locals.lang || "en", { flat: req.query.tools === "all" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    logger.error(`MCP: errore richiesta: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: res.locals.t("api.mcp.internalError") }, id: null });
    }
  }
});

router.get("/api/mcp", requireAuth, requireAgent, (req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: res.locals.t("api.mcp.methodNotAllowedPost") }, id: null });
});

router.delete("/api/mcp", requireAuth, requireAgent, (req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: res.locals.t("api.mcp.methodNotAllowed") }, id: null });
});

export default router;
