import crypto from "node:crypto";
import { requireAgent } from "./agent-helpers.js";
import { buildOpenApiDocument } from "../services/openapi-agent.js";
import config from "../config.js";

const cache = new Map(); // `${lang}|${area}` -> { body, etag }

export function registerOpenapiRoutes(router) {
  router.get("/api/agent/openapi.json", requireAgent, async (req, res, next) => {
    try {
      const lang = req.query.lang === "it" ? "it" : "en";
      const area = typeof req.query.area === "string" && /^[a-z_]{1,30}$/.test(req.query.area) ? req.query.area : null;
      const key = `${lang}|${area || ""}`;
      let entry = cache.get(key);
      if (!entry) {
        const { discoverTools } = await import("../services/mcp-tools.js");   // dynamic: evita import circolare
        const tree = await import("../services/mcp-tree.js");
        const doc = buildOpenApiDocument(discoverTools(lang), { lang, area, baseUrl: config.magicLinkBaseUrl,
          helpers: { AREAS: tree.AREAS, categoryOf: tree.categoryOf, areaOfCategory: tree.areaOfCategory } });
        const body = JSON.stringify(doc);
        entry = { body, etag: `W/"${crypto.createHash("sha1").update(body).digest("hex")}"` };
        cache.set(key, entry);
      }
      res.setHeader("ETag", entry.etag);
      res.setHeader("Cache-Control", "private, max-age=300");
      if (req.headers["if-none-match"] === entry.etag) return res.status(304).end();
      res.type("application/json").send(entry.body);
    } catch (err) { next(err); }
  });
}
