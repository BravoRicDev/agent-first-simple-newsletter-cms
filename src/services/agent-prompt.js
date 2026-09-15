import { readFileSync } from "fs";
import { discoverTools } from "./mcp-tools.js";

const PROMPT_URL = new URL("../../content/agent-prompt.md", import.meta.url);

export function buildAgentPrompt(req, lang = "en") {
  const template = readFileSync(PROMPT_URL, "utf-8");
  const mcpUrl = `${req.protocol}://${req.get("host")}/api/mcp`;
  const tools = discoverTools(lang);
  const toolsTable = tools.map((t) => `| ${t.name} | ${t.description} |`).join("\n");
  return template.replaceAll("{{MCP_URL}}", mcpUrl).replaceAll("{{TOOLS_TABLE}}", toolsTable);
}

export default buildAgentPrompt;
