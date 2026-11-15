import { z } from "zod";
import { agentRoute, created } from "./agent-kit.js";
import { createRelease, getRelease, listReleases, updateRelease, deleteRelease, addItems, removeItem, previewRelease, scheduleRelease, cancelRelease, rebaseRelease, executeRelease, mapReleaseError } from "../services/releases.js";

const itemsSchema = z.array(z.object({ page_id: z.number().int().positive(), action: z.enum(["publish", "unpublish"]) })).min(1).max(200);
const createSchema = z.object({ name: z.string().min(1).max(200), description: z.string().max(5000).optional(), items: itemsSchema.optional() });
const updateSchema = z.object({ name: z.string().min(1).max(200).optional(), description: z.string().max(5000).optional() });
const scheduleSchema = z.object({ scheduled_at: z.string().datetime({ offset: true }) });
const runSchema = z.object({ force: z.boolean().optional() });

export function registerReleasesRoutes(router) {
  const ro = { mapError: mapReleaseError };
  const rw = { mapError: mapReleaseError, write: true };
  const base = "/api/agent/sites/:siteId/releases";

  agentRoute(router, "get", base, ro, async ({ req, siteId }) => ({ releases: await listReleases(siteId, { status: req.query.status, limit: req.query.limit, offset: req.query.offset }) }));

  agentRoute(router, "post", base, rw, async ({ req, siteId }) => {
    const body = createSchema.parse(req.body ?? {});
    const release = await createRelease(siteId, body, req.user);
    if (body.items) await addItems(siteId, release.id, body.items, req.user);
    return created({ release: (await getRelease(siteId, release.id)).release });
  });

  agentRoute(router, "get", `${base}/:releaseId`, ro, async ({ siteId, ids }) => getRelease(siteId, ids.releaseId));
  agentRoute(router, "put", `${base}/:releaseId`, rw, async ({ req, siteId, ids }) => ({ release: await updateRelease(siteId, ids.releaseId, updateSchema.parse(req.body ?? {})) }));
  agentRoute(router, "delete", `${base}/:releaseId`, rw, async ({ siteId, ids }) => deleteRelease(siteId, ids.releaseId));
  agentRoute(router, "post", `${base}/:releaseId/items`, rw, async ({ req, siteId, ids }) => addItems(siteId, ids.releaseId, itemsSchema.parse(req.body?.items), req.user));
  agentRoute(router, "delete", `${base}/:releaseId/items/:pageId`, rw, async ({ siteId, ids }) => removeItem(siteId, ids.releaseId, ids.pageId));
  agentRoute(router, "get", `${base}/:releaseId/preview`, ro, async ({ siteId, ids }) => previewRelease(siteId, ids.releaseId));
  agentRoute(router, "post", `${base}/:releaseId/schedule`, rw, async ({ req, siteId, ids }) => scheduleRelease(siteId, ids.releaseId, scheduleSchema.parse(req.body ?? {}).scheduled_at, req.user));
  agentRoute(router, "post", `${base}/:releaseId/cancel`, rw, async ({ req, siteId, ids }) => ({ release: await cancelRelease(siteId, ids.releaseId, req.user) }));
  agentRoute(router, "post", `${base}/:releaseId/rebase`, rw, async ({ req, siteId, ids }) => rebaseRelease(siteId, ids.releaseId, req.user));
  agentRoute(router, "post", `${base}/:releaseId/run`, rw, async ({ req, siteId, ids }) => {
    const { force } = runSchema.parse(req.body ?? {});
    await getRelease(siteId, ids.releaseId);            // 404 se la release non e' del sito (executeRelease non conosce il sito)
    const out = await executeRelease(ids.releaseId, { force: !!force, user: req.user, source: "manual" });
    if (out.skipped) return { __status: 409, body: { error: "invalid_state", code: "invalid_state" } };
    if (!out.ok && out.conflicts) return { __status: 409, body: { error: "conflicts", code: "conflicts", conflicts: out.conflicts } };
    return out;
  });
}
