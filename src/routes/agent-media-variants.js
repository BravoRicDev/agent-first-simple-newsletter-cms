import fs from "node:fs";
import { agentRoute } from "./agent-kit.js";
import { auditLog } from "../services/audit.js";
import { getBlogSetting } from "../services/blog-settings.js";
import { isEligible, originalPath, getVariantInfo, buildSrcset, generateVariants } from "../services/image-variants.js";
import { getFocalPoint, setFocalPoint, clearFocalPoint } from "../services/media-focal.js";

const mapErr = (e) => {
  if (e?.code === "INVALID_FOCAL") return { status: 400, body: { error: "invalid_focal", code: "invalid_focal" } };
  if (e?.code === "MEDIA_NOT_FOUND") return { status: 404, body: { error: "media_not_found", code: "media_not_found" } };
  return null;
};
// null = ok; altrimenti la risposta di errore. ("api.media.notFound" NON esiste in locales: si usa un codice fisso.)
function check(siteId, filename) {
  if (!isEligible(filename)) return { __status: 400, body: { error: "unsupported_type", code: "unsupported_type" } };
  if (!fs.existsSync(originalPath(siteId, filename))) return { __status: 404, body: { error: "media_not_found", code: "media_not_found" } };
  return null;
}

export function registerMediaVariantsRoutes(router) {
  const ro = { mapError: mapErr };
  const rw = { mapError: mapErr, write: true };
  const base = "/api/agent/sites/:siteId/media/:filename";

  agentRoute(router, "get", `${base}/variants`, ro, async ({ req, siteId }) => {
    const filename = req.params.filename;
    const bad = check(siteId, filename); if (bad) return bad;
    return {
      filename, eligible: true, info: getVariantInfo(siteId, filename),
      srcset: { webp: buildSrcset(siteId, filename, "webp"), avif: buildSrcset(siteId, filename, "avif") },
      focal: await getFocalPoint(siteId, filename),
      transform_example: `/img/${siteId}/${filename}?w=640&fmt=auto`,
      mode: await getBlogSetting(siteId, "images_srcset_mode"),
    };
  });

  agentRoute(router, "put", `${base}/focal`, rw, async ({ req, siteId }) => {
    const filename = req.params.filename;
    const bad = check(siteId, filename); if (bad) return bad;
    if (req.body?.clear === true) { await clearFocalPoint(siteId, filename); return { focal: null }; }
    return { focal: await setFocalPoint(siteId, filename, req.body?.x, req.body?.y) };
  });

  agentRoute(router, "post", `${base}/variants/regenerate`, rw, async ({ req, siteId }) => {
    const filename = req.params.filename;
    const bad = check(siteId, filename); if (bad) return bad;
    const info = await generateVariants(siteId, filename);
    await auditLog({ userId: req.user.sub, siteId, entityType: "media", entityId: null, action: "variants_regen", newData: { filename }, ipAddress: req.ip });
    return { info };
  });
}
