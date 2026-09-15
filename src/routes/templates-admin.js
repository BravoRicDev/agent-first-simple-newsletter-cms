import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { normalizeUrlPath } from "../services/urls.js";

const router = Router();

// Valida un id numerico positivo da req.params/body; NaN/0/negativo/stringa
// → null (il chiamante risponde 400/404). Evita 500 da cast Postgres
// ("invalid input syntax for type integer") su input malformato.
function parseId(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveSiteId(req, res) {
  let siteId = req.user.role === "superadmin" && req.query.site_id
    ? parseInt(req.query.site_id, 10)
    // Non-superadmin: SOLO il proprio site_id (mai Host header)
    : req.user.site_id;
  if (!siteId && req.user.role === "superadmin") {
    return query("SELECT id FROM sites ORDER BY id LIMIT 1").then(rows => rows.rows[0]?.id);
  }
  return Promise.resolve(siteId);
}

router.get("/admin/templates", requireAuth, resolveSite, authorize("templates", "read"), async (req, res, next) => {
  try {
    const siteId = await resolveSiteId(req, res);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const templates = (await query(
      "SELECT id, name, description, placeholders, created_at FROM templates WHERE site_id = $1 ORDER BY name",
      [siteId]
    )).rows;
    res.render("admin/templates/index", { templates, site });
  } catch (err) { next(err); }
});

router.get("/admin/templates/new", requireAuth, resolveSite, authorize("templates", "create"), async (req, res, next) => {
  const siteId = await resolveSiteId(req, res);
  const site = siteId ? (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] : null;
  res.render("admin/templates/new", { site });
});

router.post("/admin/templates", requireAuth, authorize("templates", "create"), async (req, res, next) => {
  try {
    const { name, description, content, site_id } = req.body;
    const siteId = parseId(site_id);
    if (!siteId) {
      return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    }
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const { extractPlaceholders } = await import("../services/template-renderer.js");
    const placeholders = extractPlaceholders(content);
    await query(
      "INSERT INTO templates (site_id, name, description, content, placeholders) VALUES ($1,$2,$3,$4,$5)",
      [siteId, name, description || "", content, JSON.stringify(placeholders)]
    );
    res.redirect(`/admin/templates?site_id=${siteId}`);
  } catch (err) {
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.templates.nameExists") });
    next(err);
  }
});

router.get("/admin/templates/:id/instantiate", requireAuth, resolveSite, authorize("templates", "read"), async (req, res, next) => {
  try {
    const siteId = await resolveSiteId(req, res);
    const site = siteId ? (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] : null;
    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(404).render("error", { message: res.locals.t("api.templates.notFound") });
    const template = (await query("SELECT * FROM templates WHERE id = $1 AND site_id = $2", [templateId, siteId])).rows[0];
    if (!template) return res.status(404).render("error", { message: res.locals.t("api.templates.notFound") });
    res.render("admin/templates/instantiate", { template, site });
  } catch (err) { next(err); }
});

router.post("/admin/templates/:id/instantiate", requireAuth, authorize("templates", "create"), async (req, res, next) => {
  try {
    const { url_path, title, published, site_id, values } = req.body;
    const siteId = parseId(site_id);
    if (!siteId) {
      return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    }
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(404).render("error", { message: res.locals.t("api.templates.notFound") });
    const template = (await query("SELECT * FROM templates WHERE id = $1 AND site_id = $2", [templateId, siteId])).rows[0];
    if (!template) return res.status(404).render("error", { message: res.locals.t("api.templates.notFound") });

    const { renderTemplate } = await import("../services/template-renderer.js");
    const content = renderTemplate(template.content, values || {});
    const cleanPath = normalizeUrlPath(url_path);

    const result = await query(
      "INSERT INTO pages (site_id, url_path, title, content, published) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      // Il form invia "true" (stringa), il JSON true (booleano): accetta entrambi.
      [siteId, cleanPath, title || template.name, content, published === "true" || published === true]
    );
    res.redirect(`/admin/pages/${result.rows[0].id}/edit`);
  } catch (err) {
    if (err.message === "URL non valido") return res.status(400).render("error", { message: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

router.post("/admin/templates/:id/delete", requireAuth, authorize("templates", "delete"), async (req, res, next) => {
  try {
    const siteId = parseId(req.body.site_id);
    if (!siteId) {
      return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    }
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(404).render("error", { message: res.locals.t("api.templates.notFound") });
    await query("DELETE FROM templates WHERE id = $1 AND site_id = $2", [templateId, siteId]);
    res.redirect(`/admin/templates?site_id=${siteId}`);
  } catch (err) { next(err); }
});

export default router;
