import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { exportPublishedPages } from "../services/static-export.js";
import {
  syncHomepageSections,
  isHomepageDynamicEnabled,
  activateHomepageDynamic,
  deactivateHomepageDynamic,
} from "../services/homepage-sections.js";

const router = Router();

// Stesso pattern IDOR di src/routes/categories.js: un non-superadmin può
// operare SOLO sul proprio site_id (mai un site_id arbitrario via query
// string o Host header); il superadmin può scegliere il sito.
function resolveHomepageSiteId(req) {
  const isSuperadmin = req.user.role === "superadmin";
  const raw = isSuperadmin && (req.query.site_id || req.body.site_id)
    ? parseInt(req.query.site_id || req.body.site_id, 10)
    : req.user.site_id;
  return { isSuperadmin, siteId: Number.isFinite(raw) ? raw : null };
}

// Normalizza un id opzionale arrivato dal form: vuoto, "0" o assente → null
// (stesso criterio di pages.js: 0 non è una riga esistente).
function optionalId(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (str === "" || str === "0") return null;
  const num = Number(str);
  return Number.isInteger(num) && num > 0 ? num : null;
}

// IDOR categorie: una categoria assegnata a una sezione DEVE appartenere
// allo stesso site_id della sezione (stessa site_id del form).
async function assertCategoryBelongsToSite(categoryId, siteId) {
  if (categoryId === null) return;
  const row = (await query("SELECT id FROM categories WHERE id = $1 AND site_id = $2", [categoryId, siteId])).rows[0];
  if (!row) {
    const err = new Error("Category site mismatch");
    err.status = 400;
    err.code = "CATEGORY_SITE_MISMATCH";
    throw err;
  }
}

const sectionSchema = z.object({
  section_type: z.enum(["custom_html", "category_band", "category_feed", "all_feed"]),
  // Obbligatorio SOLO per section_type='category_feed' (verifica manuale in
  // createSectionData/updateSectionData: zod lo tiene opzionale qui).
  category_id: z.union([z.coerce.number().int().positive(), z.literal("")]).optional(),
  title: z.string().max(255).optional().default(""),
  articles_limit: z.coerce.number().int().min(1).max(1000).optional().default(6),
  custom_html: z.string().optional().default(""),
  card_template_override: z.string().max(5000).optional().default(""),
  position: z.coerce.number().int().min(0).max(9999).optional().default(0),
  // Campi booleani dal form: assente = false (stesso pattern "on"/"true" di pages.js)
  enable_client_filter: z.union([z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")]).optional().default(""),
  enabled: z.union([z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")]).optional().default(""),
});

// Estrae i campi convalidati + i 2 booleani normalizzati, con il vincolo
// category_id obbligatorio solo per category_feed.
function parseSectionData(req) {
  const data = sectionSchema.parse(req.body);
  const categoryId = optionalId(data.category_id);
  if (data.section_type === "category_feed" && categoryId === null) {
    const err = new Error("category_id richiesto per category_feed");
    err.status = 400;
    err.code = "CATEGORY_REQUIRED";
    throw err;
  }
  if (data.section_type !== "category_feed") {
    // category_id non ha senso per gli altri tipi: azzerato (niente residui)
    return { ...data, category_id: null };
  }
  return { ...data, category_id: categoryId };
}

function toBool(v) { return v === "on" || v === "true" || v === "1"; }

// GET /admin/homepage-sections - lista sezioni del sito + toggle dinamica
router.get("/admin/homepage-sections", requireAuth, resolveSite, authorize("pages", "read"), async (req, res, next) => {
  try {
    const { isSuperadmin, siteId } = resolveHomepageSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const sites = isSuperadmin
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : [];

    const sections = (await query(
      `SELECT s.*, c.name AS category_name
       FROM homepage_sections s
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.site_id = $1
       ORDER BY s.position ASC, s.id ASC`,
      [siteId]
    )).rows;
    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [siteId])).rows[0];
    const dynamicEnabled = await isHomepageDynamicEnabled(siteId);
    res.render("admin/homepage-sections/index", {
      sections, site, sites, selectedSiteId: siteId, dynamicEnabled, query: req.query,
    });
  } catch (err) { next(err); }
});

// GET /admin/homepage-sections/new - form nuova sezione
router.get("/admin/homepage-sections/new", requireAuth, resolveSite, authorize("pages", "create"), async (req, res, next) => {
  try {
    const { isSuperadmin, siteId } = resolveHomepageSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const categories = (await query("SELECT id, name FROM categories WHERE site_id = $1 ORDER BY name", [siteId])).rows;
    const sites = isSuperadmin
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : [];
    res.render("admin/homepage-sections/new", { site, categories, sites, selectedSiteId: siteId, query: req.query });
  } catch (err) { next(err); }
});

// POST /admin/homepage-sections - crea sezione
router.post("/admin/homepage-sections", requireAuth, resolveSite, authorize("pages", "create"), async (req, res, next) => {
  try {
    const { isSuperadmin, siteId } = resolveHomepageSiteId(req);
    if (!siteId) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    if (!isSuperadmin && req.body.site_id && parseInt(req.body.site_id, 10) !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const data = parseSectionData(req);
    await assertCategoryBelongsToSite(data.category_id, siteId);

    await query(
      `INSERT INTO homepage_sections
         (site_id, position, section_type, category_id, title, articles_limit,
          custom_html, card_template_override, enable_client_filter, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [siteId, data.position, data.section_type, data.category_id, data.title,
       data.articles_limit, data.custom_html, data.card_template_override || null,
       toBool(data.enable_client_filter), toBool(data.enabled)]
    );
    await syncHomepageSections(siteId).catch(() => {});
    await exportPublishedPages({ siteId }).catch(() => {});
    res.redirect(`/admin/homepage-sections?site_id=${siteId}&saved=1`);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.code === "CATEGORY_REQUIRED" || err.code === "CATEGORY_SITE_MISMATCH") {
      return res.status(400).render("error", { message: res.locals.t("api.pages.categoryInvalid") });
    }
    next(err);
  }
});

// POST /admin/homepage-sections/activate - attiva homepage dinamica
// NB: registrata PRIMA di /:id (stesso motivo di pages.js: "activate" verrebbe
// altrimenti catturato come :id dalla route di update).
router.post("/admin/homepage-sections/activate", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const { isSuperadmin, siteId } = resolveHomepageSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    if (!isSuperadmin && req.body.site_id && parseInt(req.body.site_id, 10) !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    await activateHomepageDynamic(siteId);
    await syncHomepageSections(siteId).catch(() => {});
    await exportPublishedPages({ siteId }).catch(() => {});
    res.redirect(`/admin/homepage-sections?site_id=${siteId}&activated=1`);
  } catch (err) { next(err); }
});

// POST /admin/homepage-sections/deactivate - disattiva (congela il content)
router.post("/admin/homepage-sections/deactivate", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const { isSuperadmin, siteId } = resolveHomepageSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    if (!isSuperadmin && req.body.site_id && parseInt(req.body.site_id, 10) !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    await deactivateHomepageDynamic(siteId);
    await syncHomepageSections(siteId).catch(() => {});
    await exportPublishedPages({ siteId }).catch(() => {});
    res.redirect(`/admin/homepage-sections?site_id=${siteId}&deactivated=1`);
  } catch (err) { next(err); }
});

// GET /admin/homepage-sections/:id/edit - form modifica
router.get("/admin/homepage-sections/:id/edit", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = req.user.site_id;
    const result = isSuperadmin
      ? await query("SELECT * FROM homepage_sections WHERE id = $1", [req.params.id])
      : await query("SELECT * FROM homepage_sections WHERE id = $1 AND site_id = $2", [req.params.id, siteId]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    const section = result.rows[0];
    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [section.site_id])).rows[0];
    const categories = (await query("SELECT id, name FROM categories WHERE site_id = $1 ORDER BY name", [section.site_id])).rows;
    res.render("admin/homepage-sections/edit", { section, site, categories, query: req.query });
  } catch (err) { next(err); }
});

// POST /admin/homepage-sections/:id - aggiorna sezione
router.post("/admin/homepage-sections/:id", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const section = (await query(
      "SELECT site_id FROM homepage_sections WHERE id = $1",
      [req.params.id]
    )).rows[0];
    if (!section) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    // IDOR guard: utenti non-superadmin possono modificare SOLO sezioni del proprio sito
    if (req.user.role !== "superadmin" && section.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const siteId = section.site_id;

    const data = parseSectionData(req);
    await assertCategoryBelongsToSite(data.category_id, siteId);

    await query(
      `UPDATE homepage_sections
       SET position = $1, section_type = $2, category_id = $3, title = $4,
           articles_limit = $5, custom_html = $6, card_template_override = $7,
           enable_client_filter = $8, enabled = $9, updated_at = NOW()
       WHERE id = $10 AND site_id = $11`,
      [data.position, data.section_type, data.category_id, data.title,
       data.articles_limit, data.custom_html, data.card_template_override || null,
       toBool(data.enable_client_filter), toBool(data.enabled), req.params.id, siteId]
    );
    await syncHomepageSections(siteId).catch(() => {});
    await exportPublishedPages({ siteId }).catch(() => {});
    res.redirect(`/admin/homepage-sections?site_id=${siteId}&saved=1`);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.code === "CATEGORY_REQUIRED" || err.code === "CATEGORY_SITE_MISMATCH") {
      return res.status(400).render("error", { message: res.locals.t("api.pages.categoryInvalid") });
    }
    next(err);
  }
});

// POST /admin/homepage-sections/:id/delete - elimina sezione
router.post("/admin/homepage-sections/:id/delete", requireAuth, resolveSite, authorize("pages", "delete"), async (req, res, next) => {
  try {
    const section = (await query(
      "SELECT site_id FROM homepage_sections WHERE id = $1",
      [req.params.id]
    )).rows[0];
    if (!section) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    // IDOR guard: utenti non-superadmin possono cancellare SOLO sezioni del proprio sito
    if (req.user.role !== "superadmin" && section.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const siteId = section.site_id;

    await query("DELETE FROM homepage_sections WHERE id = $1", [req.params.id]);
    await syncHomepageSections(siteId).catch(() => {});
    await exportPublishedPages({ siteId }).catch(() => {});
    res.redirect(`/admin/homepage-sections?site_id=${siteId}`);
  } catch (err) { next(err); }
});

export default router;
