import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { buildChangelogMessage } from "../services/changelog.js";
import { exportPublishedPages, createSymlinks } from "../services/static-export.js";
import { auditLog } from "../services/audit.js";
import { formatBytes } from "../services/format.js";
import { normalizeUrlPath } from "../services/urls.js";
import { listEnabledModules } from "../middleware/modules.js";
import { MODULES, MODULE_KEYS } from "../constants/modules.js";

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.resolve(__dirname, "../../backups");
const LAYOUTS_DIR = path.resolve(__dirname, "../../views/layouts");

// "admin" è il layout del pannello, mai selezionabile come layout di un sito
// pubblico. Un layout_template inesistente veniva prima accettato in
// silenzio, con fallback silenzioso su "site" (site-render.js) — un typo
// dell'admin cambiava il layout pubblicato senza alcun errore visibile.
function isValidLayoutTemplate(name) {
  if (!name || name === "admin") return false;
  return fs.existsSync(path.join(LAYOUTS_DIR, `${name}.ejs`));
}

const siteSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  layout_template: z.string().optional(),
  homepage_path: z.string().optional(),
});

router.get("/admin/sites", requireAuth, authorize("sites", "read"), async (req, res, next) => {
  try {
    let result;
    if (req.user.role === "superadmin") {
      result = await query("SELECT id, name, domain, layout_template, created_at FROM sites ORDER BY name");
    } else {
      result = await query("SELECT id, name, domain, layout_template, created_at FROM sites WHERE id = $1 ORDER BY name", [req.user.site_id]);
    }
    res.render("admin/sites/index", { sites: result.rows });
  } catch (err) { next(err); }
});

function listLayouts() {
  return fs.readdirSync(LAYOUTS_DIR)
    .filter(f => f.endsWith(".ejs"))
    .map(f => f.replace(/\.ejs$/, ""))
    .filter(name => name !== "admin")
    .sort();
}

router.get("/admin/sites/new", requireAuth, authorize("sites", "create"), (req, res) => {
  res.render("admin/sites/new", { layouts: listLayouts() });
});

router.post("/admin/sites", requireAuth, authorize("sites", "create"), async (req, res, next) => {
  try {
    const data = siteSchema.parse(req.body);
    if (data.homepage_path) data.homepage_path = normalizeUrlPath(data.homepage_path);
    if (data.layout_template && !isValidLayoutTemplate(data.layout_template)) {
      return res.status(400).render("error", { message: res.locals.t("api.sites.invalidLayoutTemplate") });
    }
    const siteResult = await query(
      "INSERT INTO sites (name, domain, layout_template, homepage_path) VALUES ($1, $2, $3, $4) RETURNING id",
      [data.name, data.domain, data.layout_template || "site", data.homepage_path || null]
    );
    const siteId = siteResult.rows[0].id;
    await query(
      "INSERT INTO site_domains (site_id, domain) VALUES ($1, $2) ON CONFLICT (domain) DO NOTHING",
      [siteId, data.domain]
    );
    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "site", entityId: siteId, action: "create",
      newData: { name: data.name, domain: data.domain },
      ipAddress: req.ip,
    });
    res.redirect("/admin/sites");
    createSymlinks().catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.message === "URL non valido") return res.status(400).render("error", { message: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.sites.domainExists") });
    next(err);
  }
});

router.get("/admin/sites/:id/edit", requireAuth, authorize("sites", "update"), async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM sites WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.common.siteNotFound") });
    if (req.user.role !== "superadmin" && result.rows[0].id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const domains = (await query("SELECT id, domain, created_at FROM site_domains WHERE site_id = $1 ORDER BY domain", [req.params.id])).rows;
    const redirects = (await query(
      "SELECT * FROM redirects WHERE site_id = $1 ORDER BY from_path",
      [req.params.id]
    )).rows;
    // Nome diverso da res.locals.enabledModules (array, impostato globalmente
    // da attachEnabledModules per la nav): express-ejs-layouts propaga le
    // variabili locali della vista anche al layout, un omonimo qui
    // sovrascriverebbe quello atteso dalla sidebar (Set non ha .includes()).
    const siteModulesEnabled = new Set((await listEnabledModules(req.params.id)));
    res.render("admin/sites/edit", { site: result.rows[0], domains, redirects, layouts: listLayouts(), siteModulesEnabled, modulesRegistry: MODULES });
  } catch (err) { next(err); }
});

router.post("/admin/sites/:id/modules/:key/toggle", requireAuth, authorize("sites", "update"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.id, 10);
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    if (!MODULE_KEYS.includes(req.params.key)) {
      return res.status(400).render("error", { message: res.locals.t("api.modules.unknownKey") });
    }
    const enabled = req.body.enabled === "1";
    await query(
      `INSERT INTO site_modules (site_id, module_key, enabled, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (site_id, module_key) DO UPDATE SET enabled = $3, updated_at = NOW()`,
      [siteId, req.params.key, enabled]
    );
    res.redirect(`/admin/sites/${siteId}/edit`);
  } catch (err) { next(err); }
});

router.post("/admin/sites/:id", requireAuth, authorize("sites", "update"), async (req, res, next) => {
  try {
    const data = siteSchema.parse(req.body);
    if (data.homepage_path) data.homepage_path = normalizeUrlPath(data.homepage_path);
    if (data.layout_template && !isValidLayoutTemplate(data.layout_template)) {
      return res.status(400).render("error", { message: res.locals.t("api.sites.invalidLayoutTemplate") });
    }
    const siteId = parseInt(req.params.id, 10);

    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const current = (await query("SELECT name, domain, layout_template, homepage_path FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!current) return res.status(404).render("error", { message: res.locals.t("api.common.siteNotFound") });

    const oldDomain = current.domain;
    const newDomain = data.domain;

    await query(
      "UPDATE sites SET name = $1, domain = $2, layout_template = $3, homepage_path = $4, updated_at = NOW() WHERE id = $5",
      [data.name, newDomain, data.layout_template || "site", data.homepage_path || null, siteId]
    );

    if (oldDomain !== newDomain) {
      await query("DELETE FROM site_domains WHERE site_id = $1 AND domain = $2", [siteId, oldDomain]);
      await query(
        "INSERT INTO site_domains (site_id, domain) VALUES ($1, $2) ON CONFLICT (domain) DO NOTHING",
        [siteId, newDomain]
      );
    }

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "site", entityId: siteId, action: "update",
      oldData: current,
      newData: { name: data.name, domain: newDomain, layout_template: data.layout_template || "site", homepage_path: data.homepage_path || null },
      ipAddress: req.ip,
    });
    res.redirect("/admin/sites");
    exportPublishedPages({ siteId }).catch(() => {});
    createSymlinks().catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.message === "URL non valido") return res.status(400).render("error", { message: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.sites.domainInUse") });
    next(err);
  }
});

router.post("/admin/sites/:id/domains", requireAuth, authorize("sites", "update"), async (req, res, next) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).render("error", { message: res.locals.t("api.sites.domainRequired") });
    const siteId = parseInt(req.params.id, 10);

    // Ownership check: utenti non-superadmin possono gestire domini SOLO del proprio sito
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    // Validazione hostname: evita path traversal (es. "../../etc") che finirebbe
    // in path.join(STATIC_ROOT, domain) dentro createSymlinks()
    const trimmed = String(domain).trim().toLowerCase();
    if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/.test(trimmed)) {
      return res.status(400).render("error", { message: res.locals.t("api.sites.domainRequired") });
    }

    await query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [siteId, trimmed]);
    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "site_domain", entityId: siteId, action: "create",
      newData: { domain: trimmed },
      ipAddress: req.ip,
    });
    res.redirect(`/admin/sites/${req.params.id}/edit`);
    createSymlinks().catch(() => {});
  } catch (err) {
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.sites.domainInUse") });
    next(err);
  }
});

router.post("/admin/sites/:id/domains/:domainId/delete", requireAuth, authorize("sites", "update"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.id, 10);

    // Ownership check: utenti non-superadmin possono eliminare domini SOLO del proprio sito
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const removed = (await query(
      "DELETE FROM site_domains WHERE id = $1 AND site_id = $2 RETURNING domain",
      [req.params.domainId, siteId]
    )).rows[0];
    if (removed) {
      await auditLog({
        userId: req.user.sub, siteId,
        entityType: "site_domain", entityId: siteId, action: "delete",
        oldData: { domain: removed.domain },
        ipAddress: req.ip,
      });
    }
    res.redirect(`/admin/sites/${req.params.id}/edit`);
    createSymlinks().catch(() => {});
  } catch (err) { next(err); }
});

const AUDIT_PAGE_SIZE = 50;

router.get("/admin/audit", requireAuth, authorize("audit", "read"), async (req, res, next) => {
  try {
    const mode = req.query.mode || "readable";

    // Filtri dinamici: prima solo site_id, ora anche utente (email, ILIKE) e
    // intervallo date — la tabella aveva già user_id/created_at disponibili
    // ma la UI non permetteva di filtrarci sopra, solo per sito.
    // Un admin di sito (non superadmin) vede solo l'audit del proprio site_id,
    // forzato lato server e non dal query param.
    const conditions = [];
    const params = [];
    if (req.user.role !== "superadmin") {
      params.push(req.user.site_id);
      conditions.push(`al.site_id = $${params.length}`);
    } else if (req.query.site_id) {
      params.push(parseInt(req.query.site_id, 10));
      conditions.push(`al.site_id = $${params.length}`);
    }
    if (req.query.user_email) {
      params.push(`%${req.query.user_email}%`);
      conditions.push(`u.email ILIKE $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conditions.push(`al.created_at >= $${params.length}::date`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conditions.push(`al.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const where = conditions.length > 0 ? "AND " + conditions.join(" AND ") : "";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * AUDIT_PAGE_SIZE;
    params.push(AUDIT_PAGE_SIZE, offset);
    const limitOffset = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const totalResult = await query(
      `SELECT COUNT(*) AS total FROM audit_log al LEFT JOIN users u ON u.id = al.user_id WHERE true ${where}`,
      params.slice(0, params.length - 2)
    );
    const total = parseInt(totalResult.rows[0].total, 10);
    const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

    const filters = {
      site_id: req.query.site_id || "",
      user_email: req.query.user_email || "",
      from: req.query.from || "",
      to: req.query.to || "",
    };

    if (mode === "readable") {
      const rows = (await query(
        `SELECT al.id, al.entity_type, al.action, al.old_data, al.new_data, al.created_at,
                u.name AS user_name, u.email AS user_email, s.name AS site_name
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.user_id
         LEFT JOIN sites s ON s.id = al.site_id
         WHERE true ${where}
         ORDER BY al.created_at DESC ${limitOffset}`,
        params
      )).rows;

      const entries = rows.map(e => ({
        ...e,
        message: buildChangelogMessage(e),
      }));
      const sites = (await query("SELECT id, name FROM sites ORDER BY name")).rows;
      return res.render("admin/audit/index", { entries, mode, logs: [], sites, selectedSiteId: req.query.site_id || "", filters, page, totalPages, total });
    }

    const logs = (await query(
      `SELECT al.id, al.action, al.entity_type, al.entity_id, al.ip_address, al.created_at,
              u.email AS user_email, s.name AS site_name,
              CASE al.entity_type
                WHEN 'page'    THEN (SELECT title FROM pages    WHERE id = al.entity_id)
                WHEN 'snippet' THEN (SELECT name  FROM snippets WHERE id = al.entity_id)
                WHEN 'user'    THEN (SELECT email FROM users    WHERE id = al.entity_id)
              END AS entity_name
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       LEFT JOIN sites s ON s.id = al.site_id
       WHERE true ${where}
       ORDER BY al.created_at DESC ${limitOffset}`,
      params
    )).rows;
    const sites = (await query("SELECT id, name FROM sites ORDER BY name")).rows;
    res.render("admin/audit/index", { logs, entries: [], mode, sites, selectedSiteId: req.query.site_id || "", filters, page, totalPages, total });
  } catch (err) { next(err); }
});

// ── Redirects admin ────────────────────────────────────────────────────────

router.post("/admin/sites/:siteId/redirects", requireAuth, authorize("sites", "update"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);

    // Ownership check: utenti non-superadmin possono gestire redirect SOLO del proprio sito
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const { from_path, to_path, code } = req.body;
    if (!from_path || !to_path) return res.status(400).render("error", { message: res.locals.t("api.sites.fromToPathRequired") });
    const fromPath = "/" + from_path.replace(/^\/+|\/+$/g, "");
    // Redirect esterno: solo http/https validi (mai javascript:/data:/ecc.),
    // che verrebbero serviti a ogni visitatore del sito pubblico.
    let toPath;
    if (to_path.startsWith("http")) {
      try {
        const parsed = new URL(to_path);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL non valido");
        toPath = to_path;
      } catch {
        return res.status(400).render("error", { message: res.locals.t("api.sites.fromToPathRequired") });
      }
    } else {
      toPath = "/" + to_path.replace(/^\/+|\/+$/g, "");
    }
    const redirectCode = [301, 302, 307, 308].includes(parseInt(code)) ? parseInt(code) : 301;
    const saved = (await query(
      `INSERT INTO redirects (site_id, from_path, to_path, code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id, from_path) DO UPDATE SET to_path = EXCLUDED.to_path, code = EXCLUDED.code
       RETURNING id`,
      [siteId, fromPath, toPath, redirectCode]
    )).rows[0];
    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "redirect", entityId: saved.id, action: "update",
      newData: { from_path: fromPath, to_path: toPath, code: redirectCode },
      ipAddress: req.ip,
    });
    res.redirect(`/admin/sites/${siteId}/edit`);
  } catch (err) { next(err); }
});

router.post("/admin/sites/:siteId/redirects/:redirectId/delete", requireAuth, authorize("sites", "update"), async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);

    // Ownership check: utenti non-superadmin possono eliminare redirect SOLO del proprio sito
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const removed = (await query(
      "DELETE FROM redirects WHERE id = $1 AND site_id = $2 RETURNING from_path, to_path",
      [req.params.redirectId, siteId]
    )).rows[0];
    if (removed) {
      await auditLog({
        userId: req.user.sub, siteId,
        entityType: "redirect", entityId: parseInt(req.params.redirectId, 10), action: "delete",
        oldData: removed,
        ipAddress: req.ip,
      });
    }
    res.redirect(`/admin/sites/${siteId}/edit`);
  } catch (err) { next(err); }
});

// ── Sitemap admin ────────────────────────────────────────────────────────────

router.get("/admin/sites/:id/sitemap", requireAuth, authorize("sites", "read"), async (req, res, next) => {
  try {
    const site = (await query("SELECT * FROM sites WHERE id = $1", [req.params.id])).rows[0];
    if (!site) return res.status(404).render("error", { message: res.locals.t("api.common.siteNotFound") });

    // Ownership check: un admin (non superadmin) vede la sitemap SOLO del proprio sito
    if (req.user.role !== "superadmin" && site.id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const allPages = (await query(
      "SELECT id, url_path, title, published, publish_at, updated_at FROM pages WHERE site_id = $1 ORDER BY url_path",
      [site.id]
    )).rows;

    const redirects = (await query(
      "SELECT from_path, to_path, code FROM redirects WHERE site_id = $1 ORDER BY from_path",
      [site.id]
    )).rows;

    res.render("admin/sites/sitemap", {
      site,
      redirects,
      pages: {
        published: allPages.filter(p => p.published),
        drafts: allPages.filter(p => !p.published && !p.publish_at),
        scheduled: allPages.filter(p => p.publish_at && !p.published),
      },
    });
  } catch (err) { next(err); }
});

// ── Backup DB admin ─────────────────────────────────────────────────────────
// Prima non esisteva alcuna vista: il backup automatico schedulato (backup.js)
// girava senza che un admin potesse mai vederne lo stato, scaricarlo, o
// accorgersi di un fallimento se non leggendo i log del server.

router.get("/admin/backups", requireAuth, async (req, res, next) => {
  if (req.user.role !== "superadmin") return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
  try {
    let files = [];
    if (fs.existsSync(BACKUP_DIR)) {
      files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith(".sql.gz") || f.endsWith(".sql"))
        .map(f => {
          const stat = fs.statSync(path.join(BACKUP_DIR, f));
          return { name: f, size_formatted: formatBytes(stat.size), mtime: stat.mtime, automatic: f.startsWith("auto-") };
        })
        .sort((a, b) => b.mtime - a.mtime);
    }
    res.render("admin/backups/index", { files });
  } catch (err) { next(err); }
});

router.get("/admin/backups/:filename/download", requireAuth, (req, res) => {
  if (req.user.role !== "superadmin") return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
  const { filename } = req.params;
  if (filename.includes("..") || filename.includes("/") || !/^[\w.\-]+\.sql(\.gz)?$/.test(filename)) {
    return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
  }
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).render("error", { message: res.locals.t("api.common.notFound") });
  res.download(filePath, filename);
});

export default router;
