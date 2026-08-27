import { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAgent } from "./agent.js";
import { discoverTools, makeToolHandler } from "../services/mcp-tools.js";
import { logger } from "../services/logger.js";

const router = Router();

// Il set di tool è derivato dal router /api/agent reale (vedi mcp-tools.js)
// e non cambia a runtime, solo per lingua: si scopre una volta per lingua e
// si riusa. Solo il server MCP + transport sono ricreati per ogni richiesta
// (pattern stateless raccomandato dall'SDK per Streamable HTTP senza
// gestione sessioni).
const toolsByLang = new Map();
function getTools(lang) {
  if (!toolsByLang.has(lang)) {
    const tools = discoverTools(lang);
    const enriched = tools.filter((t) => t.enriched).length;
    logger.info(`MCP [${lang}]: ${tools.length} tool registrati (${enriched} con schema arricchito, ${tools.length - enriched} generici)`);
    toolsByLang.set(lang, tools);
  }
  return toolsByLang.get(lang);
}

function buildServer(lang) {
  const server = new McpServer({ name: "gestione-siti-agent", version: "1.0.0" });
  for (const tool of getTools(lang)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, makeToolHandler(tool));
  }
  return server;
}

router.post("/api/mcp", requireAuth, requireAgent, async (req, res) => {
  try {
    const server = buildServer(res.locals.lang || "en");
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
