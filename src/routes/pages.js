import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { expandSnippets } from "../services/page-renderer.js";
import { auditLog } from "../services/audit.js";
import { ensureSiteDir, fetchUrlToMedia, saveBufferToMedia } from "./media.js";
import { exportPublishedPages, deleteStaticPage, fullExport } from "../services/static-export.js";
import { extractAndReplaceBase64 } from "../services/media-utils.js";
import { normalizeUrlPath } from "../services/urls.js";
import { resolveLayoutName, getSiteThemeVars } from "../services/site-render.js";
import { getPageTrackingOverride, setPageTrackingOverride } from "../services/tracking.js";
// Niente tracking (GA4/Pixel/consenso) nelle route di preview qui sotto:
// sono anteprime interne nell'iframe dell'admin, non traffico pubblico —
// iniettarlo inquinerebbe le statistiche con le visualizzazioni dell'admin
// e mostrerebbe il banner cookie dentro l'iframe di editing.

const router = Router();

const pageSchema = z.object({
  url_path: z.string().min(1),
  title: z.string().optional().default(""),
  content: z.string().optional().default(""),
  layout_mode: z.enum(["standalone", "wrapped"]).optional().default("wrapped"),
  published: z.string().optional().default("false"),
});

router.get("/admin/pages", requireAuth, resolveSite, authorize("pages", "read"), async (req, res, next) => {
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

    const pages = (await query(
      "SELECT id, url_path, title, layout_mode, published, publish_at, created_at, updated_at FROM pages WHERE site_id = $1 ORDER BY url_path",
      [siteId]
    )).rows;
    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/pages/index", { pages, site, sites, selectedSiteId: siteId, query: req.query });
  } catch (err) { next(err); }
});

router.get("/admin/pages/new", requireAuth, resolveSite, authorize("pages", "create"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;
    const site = siteId ? (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0] : null;
    res.render("admin/pages/new", { site });
  } catch (err) { next(err); }
});

router.post("/admin/pages", requireAuth, resolveSite, authorize("pages", "create"), async (req, res, next) => {
  try {
    const data = pageSchema.parse(req.body);
    data.url_path = normalizeUrlPath(data.url_path);
    // Non-superadmin: SOLO il proprio site_id (mai Host header)
    const siteId = req.user.role === "superadmin" ? (parseInt(req.body.site_id, 10) || req.user.site_id) : req.user.site_id;
    if (!siteId) return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    const publish_at = req.body.publish_at ? new Date(req.body.publish_at) : null;
    const review_at = req.body.review_at ? new Date(req.body.review_at) : null;
    await query(
      `INSERT INTO pages (site_id, url_path, title, content, layout_mode, published, publish_at, review_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [siteId, data.url_path, data.title, data.content, data.layout_mode, data.published === "true", publish_at, review_at]
    );
    res.redirect(`/admin/pages?site_id=${siteId}&saved=1`);
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.message === "URL non valido") return res.status(400).render("error", { message: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

// ── Rewrite admin ───────────────────────────────────────────────────────────
// NB: registrata PRIMA di POST /admin/pages/:id — altrimenti Express cattura
// "rewrite" come :id e la route non è mai raggiungibile.

router.post("/admin/pages/rewrite", requireAuth, async (req, res, next) => {
  try {
    const { text, action } = req.body;
    const { rewriteText } = await import("../services/llm.js");
    const rewritten = await rewriteText(text, action);
    res.json({ rewritten });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk import admin ───────────────────────────────────────────────────────
// NB: registrata PRIMA di POST /admin/pages/:id (stesso motivo di rewrite).

router.post("/admin/pages/bulk-import", requireAuth, async (req, res, next) => {
  try {
    const { urls: urlsRaw, prefix_path, site_id } = req.body;
    const siteId = parseInt(site_id, 10);
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const urls = urlsRaw.split(/\n/).map(u => u.trim()).filter(Boolean).slice(0, 50);
    const { ingestUrl } = await import("../services/ingest.js");
    const results = [];
    for (const url of urls) {
      try {
        const ingest = await ingestUrl(url);
        const parsed = new URL(url);
        const pathSegment = (prefix_path || "/importati/") + parsed.pathname.replace(/\.html?$/, "").replace(/\/$/, "");
        const cleanPath = normalizeUrlPath(pathSegment);
        await query(
          "INSERT INTO pages (site_id, url_path, title, content, published) VALUES ($1,$2,$3,$4,false) ON CONFLICT DO NOTHING",
          [siteId, cleanPath, ingest.title || "Importata", `<h1>${ingest.title || ""}</h1>${ingest.text ? "<p>" + ingest.text.slice(0, 5000) + "</p>" : ""}`]
        );
        results.push({ url, status: "ok", path: cleanPath });
      } catch (e) {
        results.push({ url, status: "error", error: e.message });
      }
    }
    const ok = results.filter(r => r.status === "ok").length;
    const errs = results.filter(r => r.status === "error").length;
    res.redirect(`/admin/pages?site_id=${siteId}&import_ok=${ok}&import_err=${errs}`);
  } catch (err) { next(err); }
});

router.get("/admin/pages/:id/edit", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    // Non-superadmin: SOLO il proprio site_id (mai Host header)
    const siteId = req.user.site_id;
    const result = isSuperadmin
      ? await query("SELECT * FROM pages WHERE id = $1", [req.params.id])
      : await query("SELECT * FROM pages WHERE id = $1 AND site_id = $2", [req.params.id, siteId]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    const snippets = (await query("SELECT id, name FROM snippets WHERE site_id = $1 ORDER BY name", [result.rows[0].site_id])).rows;
    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [result.rows[0].site_id])).rows[0];
    const seo = (await query("SELECT meta_title, meta_description, meta_keywords, canonical_url, noindex, og_image FROM page_seo WHERE page_id = $1", [result.rows[0].id])).rows[0] || {};
    // Override tracking di pagina (opzionale, tri-state: assente/null = eredita
    // dal sito) — vedi services/tracking.js. Esposti come page.tracking_* per
    // l'editor (stesso pattern dei campi SEO qui sopra).
    const trackingOverride = await getPageTrackingOverride(result.rows[0].id);
    const page = {
      ...result.rows[0], ...seo,
      tracking_pixel_enabled: trackingOverride.pixel_enabled ?? null,
      tracking_track_pageview: trackingOverride.track_pageview ?? null,
      tracking_track_lead: trackingOverride.track_lead ?? null,
    };

    const analytics = (await query(
      `SELECT
         COUNT(*) AS total_views,
         COUNT(DISTINCT session_id) AS unique_sessions,
         COUNT(*) FILTER (WHERE visited_at >= NOW() - INTERVAL '7 days') AS views_7d,
         COUNT(*) FILTER (WHERE visited_at >= NOW() - INTERVAL '30 days') AS views_30d
       FROM page_views WHERE page_id = $1`,
      [page.id]
    )).rows[0];

    const top_referrers = (await query(
      `SELECT referrer, COUNT(*) AS cnt FROM page_views
       WHERE page_id = $1 AND referrer IS NOT NULL
       GROUP BY referrer ORDER BY cnt DESC LIMIT 10`,
      [page.id]
    )).rows;

    const social_posts = (await query(
      "SELECT id, platform, message, scheduled_at, posted_at FROM social_posts WHERE page_id = $1 ORDER BY scheduled_at DESC LIMIT 20",
      [page.id]
    )).rows;

    res.render("admin/pages/edit", { page, snippets, site, query: req.query, analytics, top_referrers, social_posts });
  } catch (err) { next(err); }
});

router.post("/admin/pages/:id", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const data = pageSchema.parse(req.body);
    data.url_path = normalizeUrlPath(data.url_path);

    const page = (await query(
      "SELECT site_id, url_path, title, content, layout_mode, published FROM pages WHERE id = $1",
      [req.params.id]
    )).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    // IDOR guard: utenti non-superadmin possono modificare SOLO pagine del proprio sito
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const siteId = page.site_id;
    const oldUrlPath = page.url_path;

    // Auto-extract base64 inline (senza soglia, centralizzato)
    const { content: finalContent, converted: b64converted } = extractAndReplaceBase64(siteId, data.content);
    if (b64converted > 0) {
      data.content = finalContent;
    }

    const publish_at = req.body.publish_at ? new Date(req.body.publish_at) : null;
    const review_at = req.body.review_at ? new Date(req.body.review_at) : null;
    await query(
      `UPDATE pages SET url_path = $1, title = $2, content = $3, layout_mode = $4, published = $5,
       publish_at = $6, review_at = $7, updated_at = NOW() WHERE id = $8 AND site_id = $9`,
      [data.url_path, data.title, data.content, data.layout_mode, data.published === "true", publish_at, review_at, req.params.id, siteId]
    );

    // Snapshot dello stato precedente: salvato solo ora che l'UPDATE è andato a
    // buon fine, altrimenti (es. conflitto 23505 su url_path) restava comunque
    // una riga di versione duplicata identica allo stato pre-modifica.
    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.params.id, req.user.sub, page.url_path, page.title, page.content, page.layout_mode, page.published]
    );

    await query(
      `DELETE FROM page_versions WHERE id IN (
         SELECT id FROM page_versions WHERE page_id = $1
         ORDER BY created_at DESC OFFSET 50
       )`,
      [req.params.id]
    );

    const { meta_title, meta_description, meta_keywords, canonical_url, og_image } = req.body;
    const noindex = req.body.noindex === "on";
    await query(
      `INSERT INTO page_seo (page_id, meta_title, meta_description, meta_keywords, canonical_url, noindex, og_image, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (page_id) DO UPDATE
       SET meta_title = EXCLUDED.meta_title,
           meta_description = EXCLUDED.meta_description,
           meta_keywords = EXCLUDED.meta_keywords,
           canonical_url = EXCLUDED.canonical_url,
           noindex = EXCLUDED.noindex,
           og_image = EXCLUDED.og_image,
           updated_at = NOW()`,
      [req.params.id, meta_title || null, meta_description || null, meta_keywords || null, canonical_url || null, noindex, og_image || null]
    ).catch(() => {});

    // Override tracking di pagina: select vuota ("") → null (eredita dal
    // sito), "1" → true, "0" → false. Tutti opzionali, stesso pattern SEO
    // sopra — vedi views/admin/pages/edit.ejs.
    const parseTri = (v) => (v === "1" ? true : v === "0" ? false : null);
    await setPageTrackingOverride(req.params.id, {
      pixelEnabled: parseTri(req.body.tracking_pixel_enabled),
      trackPageview: parseTri(req.body.tracking_track_pageview),
      trackLead: parseTri(req.body.tracking_track_lead),
    }).catch(() => {});

    res.redirect(`/admin/pages?site_id=${siteId}&saved=1`);
    if (oldUrlPath !== data.url_path) {
      deleteStaticPage(siteId, oldUrlPath).catch(() => {});
    }
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.message === "URL non valido") return res.status(400).render("error", { message: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

router.post("/admin/pages/:id/publish-toggle", requireAuth, authorize("pages", "update"), async (req, res, next) => {
  try {
    const existing = (await query("SELECT site_id, url_path, published FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    if (req.user.role !== "superadmin" && existing.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const newPublished = typeof req.body.published !== "undefined"
      ? req.body.published === "true"
      : !existing.published;

    await query(
      "UPDATE pages SET published = $1, updated_at = NOW() WHERE id = $2",
      [newPublished, req.params.id]
    );
    res.redirect(`/admin/pages?site_id=${existing.site_id}`);
    if (newPublished) {
      exportPublishedPages({ siteId: existing.site_id }).catch(() => {});
    } else {
      deleteStaticPage(existing.site_id, existing.url_path).catch(() => {});
    }
  } catch (err) { next(err); }
});

router.post("/admin/pages/:id/inline-to-files", requireAuth, authorize("pages", "update"), async (req, res, next) => {
  try {
    const page = (await query("SELECT id, site_id, content FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const b64Re = /data:(image|font)\/([a-zA-Z0-9+.-]+)(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=]{20,})/g;
    const matches = [...page.content.matchAll(b64Re)];
    if (matches.length === 0) return res.redirect(`/admin/pages/${req.params.id}/edit`);

    const extMap = { jpeg:'jpg', jpg:'jpg', png:'png', gif:'gif', webp:'webp', svg:'svg', woff:'woff', woff2:'woff2', ttf:'ttf', otf:'otf', eot:'eot' };
    let html = page.content;
    let count = 0;
    let reusedCount = 0;

    for (const m of matches) {
      const [fullMatch, category, format, b64] = m;
      if (!html.includes(fullMatch)) continue;
      const normalizedFormat = format.toLowerCase().split('+')[0];
      const ext = extMap[normalizedFormat] || normalizedFormat;
      try {
        const result = saveBufferToMedia(page.site_id, Buffer.from(b64, 'base64'), ext);
        html = html.split(fullMatch).join(result.url);
        count++;
        if (result.reused) reusedCount++;
      } catch (_) {}
    }

    if (count > 0) {
      await query(
        `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
         SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
        [page.id, req.user.sub]
      );
      await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [html, page.id]);
    }

    const params = new URLSearchParams({ saved: "1", converted: count });
    if (reusedCount > 0) params.set("reused_conv", reusedCount);
    res.redirect(`/admin/pages/${req.params.id}/edit?${params}`);
    exportPublishedPages({ siteId: page.site_id }).catch(() => {});
  } catch (err) { next(err); }
});

router.post("/admin/pages/:id/extract-assets", requireAuth, authorize("pages", "update"), async (req, res, next) => {
  try {
    const page = (await query("SELECT id, site_id, content FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    const SKIP = /youtube|vimeo|youtu\.be|embed|maps\.google|fonts\.googleapis|fonts\.gstatic/i;
    const DOWNLOADABLE = /\.(jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|otf|mp4|mp3|pdf|js|css|mov)(\?|$)/i;
    const urlRe = /(?:src|href|poster|url)\s*=\s*["']?(https?:\/\/[^"'\s>)]+)["']?|url\(\s*["']?(https?:\/\/[^"'\s>)]+)["']?\s*\)/gi;

    const seen = new Set();
    const candidates = [];
    let m;
    while ((m = urlRe.exec(page.content)) !== null) {
      const url = m[1] || m[2];
      if (seen.has(url) || SKIP.test(url) || !DOWNLOADABLE.test(url)) continue;
      seen.add(url);
      candidates.push(url);
    }

    if (candidates.length === 0) return res.redirect(`/admin/pages/${req.params.id}/edit`);

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [page.id, req.user.sub]
    );

    let html = page.content;
    let count = 0;
    let reusedCount = 0;
    let dedupedCount = 0;
    let tooLargeCount = 0;
    const convertedUrls = [];

    for (const url of candidates) {
      try {
        const result = await fetchUrlToMedia(page.site_id, url);
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        html = html.replace(new RegExp(escapedUrl, 'g'), result.url);
        count++;
        if (result.reused) reusedCount++;
        if (result.deduped) dedupedCount++;
        convertedUrls.push({ original_url: url, local_url: result.url });
      } catch (err) {
        if (err.message && err.message.includes("File troppo grande")) {
          tooLargeCount++;
        }
      }
    }

    let crossPageCount = 0;

    if (count > 0) {
      await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [html, page.id]);

      for (const item of convertedUrls) {
        const otherPages = (await query(
          `SELECT id, url_path FROM pages WHERE site_id = $1 AND position($2 in content) > 0 AND id != $3`,
          [page.site_id, item.original_url, page.id]
        )).rows;
        if (otherPages.length > 0) {
          await query(
            `UPDATE pages SET content = REPLACE(content, $1, $2), updated_at = NOW()
             WHERE site_id = $3 AND position($1 in content) > 0 AND id != $4`,
            [item.original_url, item.local_url, page.site_id, page.id]
          );
          crossPageCount += otherPages.length;
        }
      }
    }

    const params = new URLSearchParams({ saved: "1", extracted: count });
    if (reusedCount > 0) params.set("reused", reusedCount);
    if (dedupedCount > 0) params.set("deduped", dedupedCount);
    if (tooLargeCount > 0) params.set("too_large", tooLargeCount);
    if (crossPageCount > 0) params.set("cross_page", crossPageCount);
    res.redirect(`/admin/pages/${req.params.id}/edit?${params}`);
    exportPublishedPages({ siteId: page.site_id }).catch(() => {});
  } catch (err) { next(err); }
});

router.post("/admin/pages/:id/delete", requireAuth, resolveSite, authorize("pages", "delete"), async (req, res, next) => {
  try {
    const page = (await query("SELECT site_id, url_path, title FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    // IDOR guard: utenti non-superadmin possono cancellare SOLO pagine del proprio sito
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    await query("DELETE FROM pages WHERE id = $1", [req.params.id]);
    await auditLog({
      userId: req.user.sub, siteId: page.site_id,
      entityType: "page", entityId: parseInt(req.params.id, 10), action: "delete",
      oldData: { url_path: page.url_path, title: page.title },
      ipAddress: req.ip,
    });
    res.redirect(`/admin/pages?site_id=${page.site_id}`);
    deleteStaticPage(page.site_id, page.url_path).catch(() => {});
  } catch (err) { next(err); }
});

// Version list
router.get("/admin/pages/:id/versions", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const page = (await query("SELECT id, url_path, site_id FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const versions = (await query(
      `SELECT pv.id, pv.created_at, pv.title, pv.url_path, pv.published, u.name AS user_name
       FROM page_versions pv
       LEFT JOIN users u ON u.id = pv.user_id
       WHERE pv.page_id = $1
       ORDER BY pv.created_at DESC`,
      [req.params.id]
    )).rows;
    res.render("admin/pages/versions", { versions, page });
  } catch (err) { next(err); }
});

// Restore version
router.post("/admin/pages/:id/versions/:versionId/restore", requireAuth, resolveSite, authorize("pages", "update"), async (req, res, next) => {
  try {
    const page = (await query("SELECT id, site_id FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const version = (await query(
      "SELECT id, url_path FROM page_versions WHERE id = $1 AND page_id = $2",
      [req.params.versionId, req.params.id]
    )).rows[0];
    if (!version) return res.status(404).render("error", { message: res.locals.t("api.pages.versionNotFound") });

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [req.params.id, req.user.sub]
    );

    // Defesa in profondità: normalizeUrlPath su url_path della versione (blocca
    // .., \\, spazi, NUL) — un path anomalo in page_versions (dati legacy,
    // inserimenti manuali) finirebbe altrimenti in urlPathToFilename → path.join
    // fuori dalla directory statica del sito.
    const safeVersionUrl = normalizeUrlPath(version.url_path);

    await query(
      `UPDATE pages SET url_path = $3, title = v.title, content = v.content,
       layout_mode = v.layout_mode, published = v.published, updated_at = NOW()
       FROM page_versions v WHERE pages.id = $1 AND v.id = $2`,
      [req.params.id, req.params.versionId, safeVersionUrl]
    );

    res.redirect(`/admin/pages/${req.params.id}/edit`);
    exportPublishedPages({ siteId: page.site_id }).catch(() => {});
  } catch (err) { next(err); }
});

// Preview (AJAX POST — renders draft content)
router.post("/admin/pages/:id/preview", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const page = (await query("SELECT site_id, title FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!page) return res.status(404).send("Pagina non trovata");
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).send("Accesso negato");
    }
    const { content, layout_mode } = req.body;
    const rendered = await expandSnippets(page.site_id, content || "");
    if (layout_mode === "standalone") return res.send(rendered);
    const site = (await query("SELECT layout_template FROM sites WHERE id = $1", [page.site_id])).rows[0];
    const layoutName = "layouts/" + resolveLayoutName(site?.layout_template);
    const themeVars = await getSiteThemeVars(page.site_id);
    // Stessi meta SEO usati da live/export (serve.js/static-export.js): senza
    // questi l'anteprima non rifletteva mai title/description effettivamente
    // pubblicati (restavano sempre vuoti in preview).
    const seo = (await query("SELECT meta_title, meta_description FROM page_seo WHERE page_id = $1", [req.params.id])).rows[0] || {};
    res.render(layoutName, {
      ...themeVars, title: page.title, content: rendered, layout: false,
      meta_title: seo.meta_title || page.title || "",
      meta_description: seo.meta_description || "",
    });
  } catch (err) { next(err); }
});

// Preview tab (GET — renders saved page)
router.get("/admin/pages/:id/preview-tab", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM pages WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).send("Pagina non trovata");
    const page = result.rows[0];
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).send("Accesso negato");
    }
    const rendered = await expandSnippets(page.site_id, page.content);
    if (page.layout_mode === "standalone") return res.send(rendered);
    const site = (await query("SELECT layout_template FROM sites WHERE id = $1", [page.site_id])).rows[0];
    const layoutName = "layouts/" + resolveLayoutName(site?.layout_template);
    const themeVars = await getSiteThemeVars(page.site_id);
    const seo = (await query("SELECT meta_title, meta_description FROM page_seo WHERE page_id = $1", [req.params.id])).rows[0] || {};
    res.render(layoutName, {
      ...themeVars, title: page.title, content: rendered, layout: false,
      meta_title: seo.meta_title || page.title || "",
      meta_description: seo.meta_description || "",
    });
  } catch (err) { next(err); }
});

// Internal links suggestion (GET — AJAX, versione admin browser; la versione
// agent /api/agent/... richiede il ruolo agent, quindi gli admin browser
// ricevevano 403. Qui il servizio è lo stesso con ownership check.
router.get("/admin/pages/:id/internal-links", requireAuth, authorize("pages", "read"), async (req, res, next) => {
  try {
    const page = (await query("SELECT id, site_id, content FROM pages WHERE id = $1", [req.params.id])).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }
    const { suggestInternalLinks } = await import("../services/internal-links.js");
    const suggestions = await suggestInternalLinks(page.site_id, page.content, page.id);
    res.json({ suggestions });
  } catch (err) { next(err); }
});

// ── Social posts admin ─────────────────────────────────────────────────────

router.post("/admin/pages/:pageId/social", requireAuth, async (req, res, next) => {
  try {
    const page = (await query("SELECT id, site_id FROM pages WHERE id = $1 AND site_id = $2", [req.params.pageId, req.user.site_id])).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    // Superadmin bypass: if user is superadmin, page.site_id from query will differ,
    // but the combined query already restricted by user's site_id, so we need an extra check
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const { platform, message, scheduled_at } = req.body;
    if (!["twitter","linkedin","facebook"].includes(platform)) return res.status(400).render("error", { message: res.locals.t("api.pages.invalidPlatform") });
    await query(
      "INSERT INTO social_posts (page_id, platform, message, scheduled_at) VALUES ($1,$2,$3,$4)",
      [req.params.pageId, platform, message, new Date(scheduled_at)]
    );
    res.redirect(`/admin/pages/${req.params.pageId}/edit`);
  } catch (err) { next(err); }
});

router.post("/admin/pages/:pageId/social/:postId/delete", requireAuth, async (req, res, next) => {
  try {
    const page = (await query("SELECT id, site_id FROM pages WHERE id = $1 AND site_id = $2", [req.params.pageId, req.user.site_id])).rows[0];
    if (!page) return res.status(404).render("error", { message: res.locals.t("api.pages.notFound") });
    if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    await query(
      "DELETE FROM social_posts WHERE id = $1 AND page_id = $2 AND posted_at IS NULL",
      [req.params.postId, req.params.pageId]
    );
    res.redirect(`/admin/pages/${req.params.pageId}/edit`);
  } catch (err) { next(err); }
});



// ── Static Export admin ─────────────────────────────────────────────────────

router.post("/admin/export-static", requireAuth, async (req, res, next) => {
  try {
    let siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;
    if (!siteId && req.user.role === "superadmin") {
      const first = (await query("SELECT id FROM sites ORDER BY id LIMIT 1")).rows[0];
      siteId = first?.id;
    }
    if (!siteId) return res.status(400).json({ error: res.locals.t("api.common.siteNotDetermined") });
    await exportPublishedPages({ siteId });
    res.json({ ok: true, message: res.locals.t("api.pages.staticExportCompleted") });
  } catch (err) { next(err); }
});

router.post("/admin/export-static-all", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "superadmin") {
      return res.status(403).json({ error: res.locals.t("api.pages.superadminOnlyExportAll") });
    }
    await fullExport();
    res.json({ ok: true, message: res.locals.t("api.pages.fullExportAllSites") });
  } catch (err) { next(err); }
});

// ── Deploy admin ────────────────────────────────────────────────────────────

router.post("/admin/deploy", requireAuth, async (req, res, next) => {
  try {
    let siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10)
      : req.user.site_id;
    if (!siteId && req.user.role === "superadmin") {
      const first = (await query("SELECT id FROM sites ORDER BY id LIMIT 1")).rows[0];
      siteId = first?.id;
    }
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotDetermined") });

    const site = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [siteId])).rows[0];

    // deploysite() esegue già l'export statico internamente (deploy.js) e ne
    // propaga gli eventuali errori in results.errors: non richiamarlo qui,
    // altrimenti l'export girerebbe due volte per ogni click su "Deploy".
    const { deploysite } = await import("../services/deploy.js");
    const results = await deploysite({
      siteId, siteName: site.name, siteDomain: site.domain,
      userId: req.user.sub, pages: [], note: req.body.note || "",
    });

    // Ricarica la dashboard
    const isSuperadmin = req.user.role === "superadmin";
    if (isSuperadmin) {
      const stats = (await query(`
        SELECT (SELECT COUNT(*) FROM sites) AS sites_total,
               (SELECT COUNT(*) FROM pages) AS pages_total,
               (SELECT COUNT(*) FROM pages WHERE published = true) AS pages_published,
               (SELECT COUNT(*) FROM snippets) AS snippets_total,
               (SELECT COUNT(*) FROM users WHERE status = 'active') AS users_active
      `)).rows[0];
      res.render("admin/dashboard", { stats, deployResult: { ok: !results.errors.length, message: results.errors.length ? `Deploy con ${results.errors.length} avvisi` : "Deploy completato" } });
    } else {
      const stats = (await query(`
        SELECT (SELECT COUNT(*) FROM pages WHERE site_id = $1) AS pages_total,
               (SELECT COUNT(*) FROM pages WHERE site_id = $1 AND published = true) AS pages_published,
               (SELECT COUNT(*) FROM snippets WHERE site_id = $1) AS snippets_total
      `, [siteId])).rows[0];
      res.render("admin/dashboard", { stats, deployResult: { ok: !results.errors.length, message: results.errors.length ? `Deploy con ${results.errors.length} avvisi` : "Deploy completato" } });
    }
  } catch (err) { next(err); }
});

export default router;
