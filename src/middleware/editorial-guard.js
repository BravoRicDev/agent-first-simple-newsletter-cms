import { query } from "../db.js";
import { requireAuth } from "./auth.js";
import { isWorkflowEnabled, canPublish } from "../services/editorial.js";
import { getBlogSetting } from "../services/blog-settings.js";

// [method, regex (case-insensitive: Express routing is), kind]. Il path viene URL-decodificato prima del match.
const ROUTES = [
  ["POST", /^\/admin\/pages\/?$/i, "admin_create"],
  ["POST", /^\/admin\/pages\/(\d+)\/?$/i, "admin_update"],
  ["POST", /^\/admin\/pages\/(\d+)\/publish-toggle\/?$/i, "admin_toggle"],
  ["POST", /^\/admin\/pages\/(\d+)\/versions\/(\d+)\/restore\/?$/i, "admin_restore"],
  ["POST", /^\/admin\/templates\/(\d+)\/instantiate\/?$/i, "admin_template"],
  ["POST", /^\/admin\/blog-settings\/?$/i, "settings"],
  ["POST", /^\/api\/agent\/sites\/(\d+)\/pages\/?$/i, "agent_create"],
  ["PUT", /^\/api\/agent\/sites\/(\d+)\/pages\/(\d+)\/?$/i, "agent_update"],
  ["POST", /^\/api\/agent\/sites\/(\d+)\/pages\/(\d+)\/publish-toggle\/?$/i, "agent_toggle"],
  ["POST", /^\/api\/agent\/sites\/(\d+)\/pages\/bulk-publish\/?$/i, "agent_bulk"],
  ["POST", /^\/api\/agent\/sites\/(\d+)\/pages\/(\d+)\/versions\/(\d+)\/restore\/?$/i, "agent_restore"],
  ["POST", /^\/api\/agent\/sites\/(\d+)\/pages\/(\d+)\/(?:restore-last|undo)\/?$/i, "agent_restore_last"],
  ["POST", /^\/api\/agent\/sites\/(\d+)\/templates\/(\d+)\/instantiate\/?$/i, "agent_template"],
  ["PUT", /^\/api\/agent\/sites\/(\d+)\/blog-settings\/?$/i, "settings"],
];

function classify(req) {
  if (req.method !== "POST" && req.method !== "PUT") return null;
  let p = req.originalUrl.split("?")[0];
  try { p = decodeURIComponent(p); } catch { return null; }
  for (const [method, re, kind] of ROUTES) {
    if (method !== req.method) continue;
    const m = re.exec(p);
    if (m) return { kind, m };
  }
  return null;
}
const truthy = (v) => v === true || v === "true" || v === "1" || v === 1 || v === "on";

async function pageRow(id, siteId = null) {
  return (await query("SELECT id, site_id, published FROM pages WHERE id = $1 AND ($2::int IS NULL OR site_id = $2)", [id, siteId])).rows[0] || null;
}

// Ritorna { siteId, publish:boolean } oppure { siteId, settings:true } oppure null (richiesta non rilevante / pagina inesistente: la route risponde 404 da sola).
async function analyse(req, { kind, m }, user) {
  const body = req.body || {};
  switch (kind) {
    case "admin_create": return { siteId: user.role === "superadmin" ? (parseInt(body.site_id, 10) || user.site_id) : user.site_id, publish: body.published === "true" };
    case "admin_template": return { siteId: user.role === "superadmin" ? (parseInt(body.site_id, 10) || user.site_id) : user.site_id, publish: body.published === "true" || body.published === true };
    case "agent_create": case "agent_template": return { siteId: parseInt(m[1], 10), publish: body.published === true };
    case "agent_bulk": return { siteId: parseInt(m[1], 10), publish: body.published === true };
    case "admin_update": { const pg = await pageRow(m[1]); if (!pg) return null; return { siteId: pg.site_id, publish: body.published === "true" && !pg.published }; }
    case "admin_toggle": { const pg = await pageRow(m[1]); if (!pg) return null;
      const target = typeof body.published !== "undefined" ? body.published === "true" : !pg.published; return { siteId: pg.site_id, publish: target && !pg.published }; }
    case "agent_update": { const pg = await pageRow(m[2], parseInt(m[1], 10)); if (!pg) return null; return { siteId: pg.site_id, publish: body.published === true && !pg.published }; }
    case "agent_toggle": { const pg = await pageRow(m[2], parseInt(m[1], 10)); if (!pg) return null;
      const target = typeof body.published === "boolean" ? body.published : !pg.published; return { siteId: pg.site_id, publish: target && !pg.published }; }
    case "admin_restore": case "agent_restore": {
      const pageId = kind === "admin_restore" ? m[1] : m[2];
      const verId = kind === "admin_restore" ? m[2] : m[3];
      const pg = await pageRow(pageId, kind === "agent_restore" ? parseInt(m[1], 10) : null); if (!pg) return null;
      const v = (await query("SELECT published FROM page_versions WHERE id = $1 AND page_id = $2", [verId, pageId])).rows[0];
      return { siteId: pg.site_id, publish: !!v?.published && !pg.published };
    }
    case "agent_restore_last": {
      const pg = await pageRow(m[2], parseInt(m[1], 10)); if (!pg) return null;
      const v = (await query("SELECT published FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [m[2]])).rows[0];
      return { siteId: pg.site_id, publish: !!v?.published && !pg.published };
    }
    case "settings": {
      if (!("editorial_workflow_enabled" in body)) return null;
      const siteId = kind === "settings" && req.originalUrl.toLowerCase().startsWith("/api/agent") ? parseInt(m[1], 10) : user.site_id;
      if (!siteId) return null;
      const next = String(body.editorial_workflow_enabled ?? "").trim() === "1" ? "1" : "0";
      const cur = (await getBlogSetting(siteId, "editorial_workflow_enabled", { ttlMs: 0 })) === "1" ? "1" : "0";
      return next === cur ? null : { siteId, settings: true };
    }
    default: return null;
  }
}

export function editorialGuard(req, res, next) {
  const hit = classify(req);
  if (!hit) return next();
  requireAuth(req, res, async (authErr) => {
    if (authErr) return next(authErr);
    try {
      const info = await analyse(req, hit, req.user);
      if (!info || !info.siteId) return next();
      if (!info.settings && !info.publish) return next();
      if (!info.settings && !(await isWorkflowEnabled(info.siteId))) return next();
      if (await canPublish(req.user, info.siteId)) return next();
      const message = res.locals.t("api.editorial.publishForbidden");
      if (req.originalUrl.toLowerCase().startsWith("/api")) {
        return res.status(403).json({ error: "editorial_review_required", code: "editorial_review_required", message });
      }
      return res.status(403).render("error", { message });
    } catch (err) { return next(err); }
  });
}
