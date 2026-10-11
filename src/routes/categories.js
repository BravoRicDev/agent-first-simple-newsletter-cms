import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { getBlogConfig, setBlogConfig } from "../services/blog-settings.js";

const router = Router();

// Risolve il site_id per le route blog-settings con lo stesso pattern IDOR
// delle route categorie: un non-superadmin può operare SOLO sul proprio
// site_id (mai un site_id arbitrario via query string o Host header).
function resolveSettingsSiteId(req, res) {
  const isSuperadmin = req.user.role === "superadmin";
  const raw = isSuperadmin && (req.query.site_id || req.body.site_id)
    ? parseInt(req.query.site_id || req.body.site_id, 10)
    : req.user.site_id;
  return { isSuperadmin, siteId: Number.isFinite(raw) ? raw : null };
}

// Slug validation: solo [a-z0-9]+(-[a-z0-9]+)* in minuscolo
function validateSlug(slug) {
  if (!slug || typeof slug !== "string") return false;
  // Regex: lowercase letters, digits, hyphens between alphanumerics (no leading/trailing/consecutive hyphens)
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

const categorySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).refine(validateSlug, "Slug non valido: solo lettere minuscole, numeri e trattini tra alfanumerici (es. mia-categoria)"),
  description: z.string().optional().default(""),
});

// GET /admin/blog-settings - configurazione blog per-sito
router.get("/admin/blog-settings", requireAuth, resolveSite, authorize("pages", "read"), async (req, res, next) => {
  try {
    const { isSuperadmin, siteId } = resolveSettingsSiteId(req, res);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const config = await getBlogConfig(siteId);
    res.render("admin/categories/settings", { config, site, sites, selectedSiteId: siteId, query: req.query });
  } catch (err) { next(err); }
});

router.post("/admin/blog-settings", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const { isSuperadmin, siteId } = resolveSettingsSiteId(req, res);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    if (!isSuperadmin && req.body.site_id && parseInt(req.body.site_id, 10) !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    await setBlogConfig(siteId, req.body);
    res.redirect(`/admin/blog-settings?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

// GET /admin/categories - list
router.get("/admin/categories", requireAuth, resolveSite, authorize("pages", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";

    const sites = isSuperadmin
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : [];

    let siteId = isSuperadmin && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      // Non-superadmin: SOLO il proprio site_id dal JWT. Mai res.locals.site
      // (deriva dall'Host header, controllabile dall'attaccante): un utente con
      // site_id null non deve poter scegliere il sito via Host.
      : req.user.site_id;

    if (!siteId && isSuperadmin && sites.length > 0) {
      siteId = sites[0].id;
    }

    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const categories = (await query(
      "SELECT id, name, slug, description, created_at, updated_at FROM categories WHERE site_id = $1 ORDER BY name",
      [siteId]
    )).rows;
    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/categories/index", { categories, site, sites, selectedSiteId: siteId, query: req.query });
  } catch (err) { next(err); }
});

// GET /admin/categories/new - new form
router.get("/admin/categories/new", requireAuth, resolveSite, authorize("pages", "create"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;
    const site = siteId ? (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] : null;
    res.render("admin/categories/new", { site });
  } catch (err) { next(err); }
});

// POST /admin/categories - create
router.post("/admin/categories", requireAuth, resolveSite, authorize("pages", "create"), async (req, res, next) => {
  try {
    const data = categorySchema.parse(req.body);
    // Non-superadmin: SOLO il proprio site_id (mai Host header)
    const siteId = req.user.role === "superadmin" ? (parseInt(req.body.site_id, 10) || req.user.site_id) : req.user.site_id;
    if (!siteId) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    await query(
      `INSERT INTO categories (site_id, name, slug, description)
       VALUES ($1, $2, $3, $4)`,
      [siteId, data.name, data.slug, data.description]
    );
    res.redirect(`/admin/categories?site_id=${siteId}&saved=1`);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") }); // unique constraint
    next(err);
  }
});

// GET /admin/categories/:id/edit - edit form
router.get("/admin/categories/:id/edit", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    // Non-superadmin: SOLO il proprio site_id (mai Host header)
    const siteId = req.user.site_id;
    const result = isSuperadmin
      ? await query("SELECT * FROM categories WHERE id = $1", [req.params.id])
      : await query("SELECT * FROM categories WHERE id = $1 AND site_id = $2", [req.params.id, siteId]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    const category = result.rows[0];
    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [category.site_id])).rows[0];
    res.render("admin/categories/edit", { category, site, query: req.query });
  } catch (err) { next(err); }
});

// POST /admin/categories/:id/update - update
router.post("/admin/categories/:id/update", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const data = categorySchema.parse(req.body);

    const category = (await query(
      "SELECT site_id FROM categories WHERE id = $1",
      [req.params.id]
    )).rows[0];
    if (!category) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    // IDOR guard: utenti non-superadmin possono modificare SOLO categorie del proprio sito
    if (req.user.role !== "superadmin" && category.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const siteId = category.site_id;

    await query(
      `UPDATE categories SET name = $1, slug = $2, description = $3, updated_at = NOW() WHERE id = $4 AND site_id = $5`,
      [data.name, data.slug, data.description, req.params.id, siteId]
    );

    res.redirect(`/admin/categories?site_id=${siteId}&saved=1`);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    next(err);
  }
});

// POST /admin/categories/:id/delete - delete
router.post("/admin/categories/:id/delete", requireAuth, resolveSite, authorize("pages", "delete"), async (req, res, next) => {
  try {
    const category = (await query("SELECT site_id FROM categories WHERE id = $1", [req.params.id])).rows[0];
    if (!category) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    // IDOR guard: utenti non-superadmin possono cancellare SOLO categorie del proprio sito
    if (req.user.role !== "superadmin" && category.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const siteId = category.site_id;

    // Lo schema usa ON DELETE SET NULL: la cancellazione è sempre permessa,
    // le pagine che referenziavano la categoria perdono semplicemente category_id (NULL).
    await query("DELETE FROM categories WHERE id = $1", [req.params.id]);
    res.redirect(`/admin/categories?site_id=${siteId}`);
  } catch (err) { next(err); }
});

export default router;