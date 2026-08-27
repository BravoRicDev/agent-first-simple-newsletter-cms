import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { exportPublishedPages } from "../services/static-export.js";

const router = Router();

// Valida un id numerico positivo; null se malformato (evita 500 da cast
// Postgres su input tipo "abc" in /admin/snippets/:id/*).
function parseId(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Il nome deve rispettare lo stesso pattern usato da SNIPPET_RE in
// page-renderer.js per espandere {{snippet:nome}}: un nome fuori da questo
// pattern sarebbe salvabile ma mai utilizzabile in nessuna pagina.
const snippetSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Nome non valido: solo lettere, numeri, _ e -"),
  content: z.string().optional().default(""),
  description: z.string().optional().default(""),
});

router.get("/admin/snippets", requireAuth, resolveSite, authorize("snippets", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    let siteId = isSuperadmin && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      // Non-superadmin: SOLO il proprio site_id (mai Host header controllabile)
      : req.user.site_id;
    // Un superadmin non ha site_id proprio: senza questo fallback il link
    // "Snippet" in sidebar (che non porta site_id) rispondeva 400 — stesso
    // ripiego già usato da forms.js/media.js sul primo sito disponibile.
    if (!siteId && isSuperadmin) {
      siteId = (await query("SELECT id FROM sites ORDER BY name LIMIT 1")).rows[0]?.id;
    }
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    const snippets = (await query(
      "SELECT id, name, description, created_at, updated_at FROM snippets WHERE site_id = $1 ORDER BY name",
      [siteId]
    )).rows;
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/snippets/index", { snippets, site, query: req.query });
  } catch (err) { next(err); }
});

router.get("/admin/snippets/new", requireAuth, resolveSite, authorize("snippets", "create"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;
    const site = siteId ? (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] : null;
    res.render("admin/snippets/new", { site });
  } catch (err) { next(err); }
});

router.post("/admin/snippets", requireAuth, resolveSite, authorize("snippets", "create"), async (req, res, next) => {
  try {
    const data = snippetSchema.parse(req.body);
    // Non-superadmin: SOLO il proprio site_id (mai Host header)
    const siteId = req.user.role === "superadmin" ? (parseInt(req.body.site_id, 10) || req.user.site_id) : req.user.site_id;
    if (!siteId) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    await query(
      "INSERT INTO snippets (site_id, name, content, description) VALUES ($1, $2, $3, $4)",
      [siteId, data.name, data.content, data.description]
    );
    res.redirect(`/admin/snippets?site_id=${siteId}&saved=1`);
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.snippets.nameExists") });
    next(err);
  }
});

router.get("/admin/snippets/:id/edit", requireAuth, resolveSite, authorize("snippets", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    // Non-superadmin: SOLO il proprio site_id (mai Host header)
    const siteId = req.user.site_id;
    const snippetId = parseId(req.params.id);
    if (!snippetId) return res.status(404).render("error", { message: res.locals.t("api.snippets.notFound") });
    const result = isSuperadmin
      ? await query("SELECT * FROM snippets WHERE id = $1", [snippetId])
      : await query("SELECT * FROM snippets WHERE id = $1 AND site_id = $2", [snippetId, siteId]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.snippets.notFound") });
    res.render("admin/snippets/edit", { snippet: result.rows[0] });
  } catch (err) { next(err); }
});

router.post("/admin/snippets/:id", requireAuth, resolveSite, authorize("snippets", "update"), async (req, res, next) => {
  try {
    const data = snippetSchema.parse(req.body);
    const snippetId = parseId(req.params.id);
    if (!snippetId) return res.status(404).render("error", { message: res.locals.t("api.snippets.notFound") });
    const snippet = (await query("SELECT site_id FROM snippets WHERE id = $1", [snippetId])).rows[0];
    if (!snippet) return res.status(404).render("error", { message: res.locals.t("api.snippets.notFound") });
    if (req.user.role !== "superadmin" && snippet.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    await query(
      "UPDATE snippets SET name = $1, content = $2, description = $3, updated_at = NOW() WHERE id = $4 AND site_id = $5",
      [data.name, data.content, data.description, snippetId, snippet.site_id]
    );
    res.redirect(`/admin/snippets?site_id=${snippet.site_id}&saved=1`);
    exportPublishedPages({ siteId: snippet.site_id }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    next(err);
  }
});

router.get("/admin/snippets/:id/usage-check", requireAuth, authorize("snippets", "read"), async (req, res, next) => {
  try {
    const snippetId = parseId(req.params.id);
    if (!snippetId) return res.status(404).json({ error: res.locals.t("api.snippets.notFound") });
    const snippet = (await query("SELECT id, name, site_id FROM snippets WHERE id = $1", [snippetId])).rows[0];
    if (!snippet) return res.status(404).json({ error: res.locals.t("api.snippets.notFound") });
    if (req.user.role !== "superadmin" && snippet.site_id !== req.user.site_id) {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }

    const tag = `{{snippet:${snippet.name}}}`;
    const pages = (await query(
      "SELECT id, url_path FROM pages WHERE site_id = $1 AND content LIKE $2",
      [snippet.site_id, `%${tag}%`]
    )).rows;

    res.json({ pages_count: pages.length, pages });
  } catch (err) { next(err); }
});

router.post("/admin/snippets/:id/delete", requireAuth, resolveSite, authorize("snippets", "delete"), async (req, res, next) => {
  try {
    const snippetId = parseId(req.params.id);
    if (!snippetId) return res.status(404).render("error", { message: res.locals.t("api.snippets.notFound") });
    const snippet = (await query("SELECT site_id FROM snippets WHERE id = $1", [snippetId])).rows[0];
    if (!snippet) return res.status(404).render("error", { message: res.locals.t("api.snippets.notFound") });
    if (req.user.role !== "superadmin" && snippet.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    await query("DELETE FROM snippets WHERE id = $1 AND site_id = $2", [snippetId, snippet.site_id]);
    res.redirect(`/admin/snippets?site_id=${snippet.site_id}`);
    exportPublishedPages({ siteId: snippet.site_id }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
