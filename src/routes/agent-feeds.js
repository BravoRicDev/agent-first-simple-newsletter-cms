import { agentRoute } from "./agent-kit.js";
import { getCanonicalBaseUrl } from "../services/urls.js";
import { getFeedConfig, listFeedCategories, feedPath } from "../services/feed.js";

export function registerFeedsRoutes(router) {
  agentRoute(router, "get", "/api/agent/sites/:siteId/feeds", {}, async ({ siteId }) => {
    const cfg = await getFeedConfig(siteId);
    const base = await getCanonicalBaseUrl(siteId);
    const feeds = [];
    if (cfg.enabled) {
      for (const type of ["rss", "atom"]) feeds.push({ type, scope: "all", category_slug: null, path: feedPath(type), url: base + feedPath(type) });
      for (const c of await listFeedCategories(siteId)) {
        for (const type of ["rss", "atom"]) feeds.push({ type, scope: "category", category_slug: c.slug, path: feedPath(type, c.slug), url: base + feedPath(type, c.slug) });
      }
    }
    return { enabled: cfg.enabled, item_limit: cfg.limit, full_content: cfg.full, feeds };
  });
}
