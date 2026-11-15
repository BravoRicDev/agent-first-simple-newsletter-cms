import { z } from "zod";
import { requireAgent, canAccessSite } from "./agent-helpers.js";
import { requireTokenWrite } from "../middleware/scopes.js";

export const created = (body) => ({ __status: 201, body });

// Registra UNA route agent. La route finisce nello stack del router agent => discoverTools() la vede (MCP/OpenAPI).
// requireAuth NON e' qui: lo applica gia' il guard router-level installato da registerCrmRoutes (vale per ogni route /api/agent registrata DOPO).
// write:true aggiunge requireTokenWrite. Gli id nel path (parametri che finiscono in "Id") sono validati (interi >= 1, altrimenti 400 invalid_id);
// se c'e' :siteId viene verificato canAccessSite (403 api.common.forbiddenSite).
// handler({req,res,siteId,ids}) ritorna un oggetto (=> 200 JSON), created(obj) (=> 201), oppure risponde da solo (res.headersSent).
// mapError(err, t) ritorna {status, body} oppure null (=> next(err)).
export function agentRoute(router, method, routePath, { write = false, mapError = null } = {}, handler) {
  const mw = write ? [requireAgent, requireTokenWrite] : [requireAgent];
  router[method](routePath, ...mw, async (req, res, next) => {
    try {
      const ids = {};
      for (const [k, v] of Object.entries(req.params)) {
        if (!k.endsWith("Id")) continue;
        const n = Number(v);
        if (!/^\d+$/.test(String(v)) || !Number.isSafeInteger(n) || n < 1) {
          return res.status(400).json({ error: "invalid_id", code: "invalid_id", param: k });
        }
        ids[k] = n;
      }
      const siteId = ids.siteId ?? null;
      if (siteId !== null && !(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
      }
      const out = await handler({ req, res, siteId, ids });
      if (res.headersSent || out === undefined) return undefined;
      if (out && out.__status) return res.status(out.__status).json(out.body);
      return res.json(out);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          error: "validation_failed", code: "validation_failed",
          fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })),
        });
      }
      const m = mapError ? mapError(err, res.locals.t) : null;
      if (m) return res.status(m.status).json(m.body);
      return next(err);
    }
  });
}
