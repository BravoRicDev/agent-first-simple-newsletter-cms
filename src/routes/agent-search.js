import { agentRoute } from "./agent-kit.js";
import { auditLog } from "../services/audit.js";
import { searchPages, reindexSite } from "../services/search.js";

export function registerSearchRoutes(router) {
  agentRoute(router, "get", "/api/agent/sites/:siteId/search", {}, async ({ req, siteId }) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2 || q.length > 100) return { __status: 400, body: { error: "invalid_query", code: "invalid_query" } };
    const includeUnpublished = ["true", "1"].includes(String(req.query.include_unpublished));
    return { q, ...(await searchPages(siteId, q, { limit: req.query.limit, offset: req.query.offset, includeUnpublished })) };
  });
  agentRoute(router, "post", "/api/agent/sites/:siteId/search/reindex", { write: true }, async ({ req, siteId }) => {
    const reindexed = await reindexSite(siteId);
    await auditLog({ userId: req.user.sub, siteId, entityType: "site", entityId: siteId, action: "search_reindex", newData: { reindexed }, ipAddress: req.ip });
    return { reindexed };
  });
}
