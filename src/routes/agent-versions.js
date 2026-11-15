import { query } from "../db.js";
import { auditLog } from "../services/audit.js";
import { agentRoute, created } from "./agent-kit.js";
import { getVersion, diffVersions, snapshotPage, mapVersionError } from "../services/page-versions.js";

function coded(code) { const e = new Error(code); e.code = code; return e; }
async function assertPage(siteId, pageId) {
  const r = await query("SELECT id FROM pages WHERE id = $1 AND site_id = $2", [pageId, siteId]);
  if (!r.rows[0]) throw coded("PAGE_NOT_FOUND");
}
const REF_RE = /^(current|\d+)$/;

export function registerVersionsRoutes(router) {
  const ro = { mapError: mapVersionError };
  const rw = { mapError: mapVersionError, write: true };

  agentRoute(router, "get", "/api/agent/sites/:siteId/pages/:pageId/versions/:versionId", ro, async ({ req, siteId, ids }) => {
    await assertPage(siteId, ids.pageId);
    const version = await getVersion(ids.pageId, ids.versionId, { maxChars: req.query.max_chars });
    if (!version) throw coded("VERSION_NOT_FOUND");
    return { version };
  });

  agentRoute(router, "get", "/api/agent/sites/:siteId/pages/:pageId/version-diff", ro, async ({ req, siteId, ids }) => {
    let from = req.query.from === undefined || req.query.from === "" ? null : String(req.query.from);
    const to = req.query.to === undefined || req.query.to === "" ? "current" : String(req.query.to);
    if ((from !== null && !REF_RE.test(from)) || !REF_RE.test(to)) {
      return { __status: 400, body: { error: "invalid_ref", code: "invalid_ref" } };
    }
    if (from === null) {
      await assertPage(siteId, ids.pageId);
      const last = (await query("SELECT id FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [ids.pageId])).rows[0];
      if (!last) return { __status: 400, body: { error: "no_versions", code: "no_versions" } };
      from = String(last.id);
    }
    return diffVersions(siteId, ids.pageId, from, to, { context: req.query.context, maxChars: req.query.max_chars });
  });

  agentRoute(router, "post", "/api/agent/sites/:siteId/pages/:pageId/versions", rw, async ({ req, siteId, ids }) => {
    await assertPage(siteId, ids.pageId);
    const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 255) : null;
    const v = await snapshotPage(ids.pageId, req.user.sub, { source: "agent", label });
    await auditLog({ userId: req.user.sub, siteId, entityType: "page", entityId: ids.pageId, action: "snapshot",
      newData: { version_id: v?.id ?? null, label, source: "agent" }, ipAddress: req.ip });
    return created({ version: v });
  });
}
