import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import agentInstructionsRoutes from "../src/routes/agent-instructions.js";
import humanGuideRoutes from "../src/routes/human-guide.js";

describe("pagine pubbliche self-documenting: GET /agent e GET /human-guide", () => {
  let server, baseUrl;

  before(async () => {
    const app = express();
    app.use((req, res, next) => { res.locals.t = (k) => k; res.locals.lang = "it"; next(); });
    app.use(agentInstructionsRoutes);
    app.use(humanGuideRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
  });

  test("GET /agent risponde 200 con content-type testuale e placeholder sostituito", async () => {
    const res = await fetch(`${baseUrl}/agent`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.includes("text/plain"), `content-type atteso text/plain, ottenuto: ${ct}`);
    const body = await res.text();
    assert.ok(body.length > 100, "body troppo corto");
    assert.ok(!body.includes("{{MCP_URL}}"), "placeholder {{MCP_URL}} non sostituito");
    assert.ok(!body.includes("{{TOOLS_TABLE}}"), "placeholder {{TOOLS_TABLE}} non sostituito");
    assert.ok(body.includes("/api/mcp"), "body dovrebbe contenere /api/mcp");
  });

  test("GET /human-guide risponde 200 con contenuto testuale", async () => {
    const res = await fetch(`${baseUrl}/human-guide`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.length > 50, "body human-guide troppo corto");
  });
});
