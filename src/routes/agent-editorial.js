import { query } from "../db.js";
import { agentRoute } from "./agent-kit.js";
import { isWorkflowEnabled, effectiveStatus, allowedActions, transition, listQueue, listReviews, mapEditorialError } from "../services/editorial.js";

export function registerEditorialRoutes(router) {
  const ro = { mapError: mapEditorialError };
  const rw = { mapError: mapEditorialError, write: true };

  agentRoute(router, "get", "/api/agent/sites/:siteId/editorial/queue", ro, async ({ req, siteId }) => {
    const status = typeof req.query.status === "string" ? req.query.status : "in_review";
    return { enabled: await isWorkflowEnabled(siteId), status, items: await listQueue(siteId, { status, limit: req.query.limit, offset: req.query.offset }) };
  });

  agentRoute(router, "get", "/api/agent/sites/:siteId/pages/:pageId/editorial", ro, async ({ req, res, siteId, ids }) => {
    const page = (await query("SELECT * FROM pages WHERE id = $1 AND site_id = $2", [ids.pageId, siteId])).rows[0];
    if (!page) return { __status: 404, body: { error: res.locals.t("api.pages.notFound") } };
    if (!(await isWorkflowEnabled(siteId))) return { enabled: false };
    return { enabled: true, status: effectiveStatus(page), allowed_actions: await allowedActions(page, req.user, siteId), history: await listReviews(siteId, page.id) };
  });

  agentRoute(router, "post", "/api/agent/sites/:siteId/pages/:pageId/editorial/:action", rw, async ({ req, siteId, ids }) => {
    const out = await transition(siteId, ids.pageId, req.params.action, req.user, { comment: req.body?.comment, ip: req.ip });
    const p = out.page;
    return { ok: true, from: out.from, to: out.to, page: { id: p.id, url_path: p.url_path, published: p.published, editorial_status: p.editorial_status } };
  });
}
