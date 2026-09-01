import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { expandSnippets } from "../services/page-renderer.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveLayoutName, getSiteThemeVars } from "../services/site-render.js";
import { getSiteTrackingConfigMasked, getEffectiveTrackingConfig, renderTrackingBlocks, injectTrackingIntoStandalone } from "../services/tracking.js";
import { getSiteSeoConfig } from "../services/site-seo.js";
import {
  getPublishedPagesForSitemap, buildSitemapXml, buildRobotsTxt,
  buildCanonicalUrl, toAbsoluteUrl, buildWebsiteJsonLd, buildWebPageJsonLd, serializeJsonLd,
  injectSeoIntoStandalone,
} from "../services/seo.js";
import { getCanonicalBaseUrl } from "../services/urls.js";
import { createApiToken, listApiTokens, revokeApiToken } from "../services/api-tokens.js";
import config from "../config.js";

const router = Router();

// Limiter per il rendering pubblico (catch-all): ogni richiesta costa ~6-8
// query DB (redirect + pagina + seo + page_views + theme + tracking) ed è
// anonima. Senza limite un IP qualsiasi poteva martellare il DB (DoS).
// 150 req/min per IP è ampio per un visitatore umano ma blocca i loop.
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: res.locals.t("api.common.databaseUnreachable") });
  }
});

router.get("/admin", requireAuth, (req, res) => {
  res.redirect("/admin/dashboard");
});

router.get("/admin/dashboard", requireAuth, async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = req.user.site_id;

    let stats = {};

    if (isSuperadmin) {
      const r = await query(`
        SELECT
          (SELECT COUNT(*) FROM sites) AS sites_total,
          (SELECT COUNT(*) FROM pages) AS pages_total,
          (SELECT COUNT(*) FROM pages WHERE published = true) AS pages_published,
          (SELECT COUNT(*) FROM snippets) AS snippets_total,
          (SELECT COUNT(*) FROM users WHERE status = 'active') AS users_active
      `);
      stats = r.rows[0];
      const lastEdit = (await query(
        `SELECT p.url_path, p.title, p.updated_at, u.name AS user_name
         FROM audit_log al
         LEFT JOIN pages p ON p.id = al.entity_id AND al.entity_type = 'page'
         LEFT JOIN users u ON u.id = al.user_id
         WHERE al.action IN ('create','update','restore')
         ORDER BY al.created_at DESC LIMIT 5`
      )).rows;
      stats.last_edits = lastEdit;
    } else if (siteId) {
      const r = await query(`
        SELECT
          (SELECT COUNT(*) FROM pages WHERE site_id = $1) AS pages_total,
          (SELECT COUNT(*) FROM pages WHERE site_id = $1 AND published = true) AS pages_published,
          (SELECT COUNT(*) FROM pages WHERE site_id = $1 AND published = false) AS pages_draft,
          (SELECT COUNT(*) FROM snippets WHERE site_id = $1) AS snippets_total
      `, [siteId]);
      stats = r.rows[0];
      const lastEdit = (await query(
        `SELECT p.url_path, p.title, p.updated_at, u.name AS user_name
         FROM audit_log al
         LEFT JOIN pages p ON p.id = al.entity_id AND al.entity_type = 'page'
         LEFT JOIN users u ON u.id = al.user_id
         WHERE al.site_id = $1 AND al.action IN ('create','update','restore')
         ORDER BY al.created_at DESC LIMIT 5`,
        [siteId]
      )).rows;
      stats.last_edits = lastEdit;
    }

    res.render("admin/dashboard", { stats });
  } catch (err) { next(err); }
});

router.get("/admin/agent", requireAuth, async (req, res, next) => {
  if (req.user.role !== "superadmin") return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
  try {
    const ingestLog = (await query(
      `SELECT il.source_url, il.result_type, il.title, il.word_count, il.created_at,
              s.name AS site_name, u.email AS user_email
       FROM ingest_log il
       LEFT JOIN sites s ON s.id = il.site_id
       LEFT JOIN users u ON u.id = il.user_id
       ORDER BY il.created_at DESC LIMIT 20`
    )).rows;
    const tokens = await listApiTokens(req.user.sub);
    res.render("admin/agent/index", { baseUrl: config.magicLinkBaseUrl, ingestLog, tokens, newToken: null });
  } catch (err) { next(err); }
});

// Genera un token API per l'AGENTE direttamente da questa pagina: il token
// (agtok_...) viene mostrato UNA SOLA VOLTA (come /admin/api-tokens) e l'agente
// lo usa come "Authorization: Bearer agtok_...". Nessun OTP, nessuna email.
// Il token agisce con i permessi dell'utente che lo crea.
const AGENT_TOKEN_DAYS = new Set([30, 60, 90, 120, 180, 365]);

router.post("/admin/agent/token", requireAuth, async (req, res, next) => {
  if (req.user.role !== "superadmin") return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
  try {
    const name = String(req.body.name || "").trim().slice(0, 255) || "Agente AI";
    const days = AGENT_TOKEN_DAYS.has(parseInt(req.body.expires_days, 10)) ? parseInt(req.body.expires_days, 10) : 120;
    const created = await createApiToken(req.user.sub, name, days);
    const tokens = await listApiTokens(req.user.sub);
    const ingestLog = (await query(
      `SELECT il.source_url, il.result_type, il.title, il.word_count, il.created_at,
              s.name AS site_name, u.email AS user_email
       FROM ingest_log il
       LEFT JOIN sites s ON s.id = il.site_id
       LEFT JOIN users u ON u.id = il.user_id
       ORDER BY il.created_at DESC LIMIT 20`
    )).rows;
    // Il token in chiaro è disponibile SOLO in questa risposta (stesso modello
    // di /admin/api-tokens): dopo il reload non sarà più recuperabile.
    res.render("admin/agent/index", { baseUrl: config.magicLinkBaseUrl, ingestLog, tokens, newToken: created });
  } catch (err) { next(err); }
});

router.post("/admin/agent/token/:id/revoke", requireAuth, async (req, res, next) => {
  if (req.user.role !== "superadmin") return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
  try {
    await revokeApiToken(req.user.sub, req.params.id);
    res.redirect("/admin/agent");
  } catch (err) { next(err); }
});

router.get("/sitemap.xml", resolveSite, async (req, res, next) => {
  try {
    if (!req.site?.id) return res.status(404).send("Sito non trovato");
    const baseUrl = await getCanonicalBaseUrl(req.site.id, { req });
    const pages = await getPublishedPagesForSitemap(req.site.id);
    // Cache: la sitemap cambia solo su publish/export → 1h di cache browser/CDN.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("application/xml").send(buildSitemapXml(baseUrl, pages));
  } catch (err) { next(err); }
});

router.get("/robots.txt", resolveSite, async (req, res, next) => {
  try {
    if (!req.site?.id) return res.status(404).send("Sito non trovato");
    const baseUrl = await getCanonicalBaseUrl(req.site.id, { req });
    const siteSeo = await getSiteSeoConfig(req.site.id);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("text/plain").send(buildRobotsTxt(baseUrl, siteSeo.robotsExtra));
  } catch (err) { next(err); }
});

// Catch-all del sito pubblico: risolve qualunque path come pagina del sito
// (o redirect alla home se non esiste), quindi NON restituisce mai il
// controllo con next() a chi viene dopo. Sta su un router separato,
// montato per ultimo in index.js dopo tutte le altre route: montato
// insieme alle route specifiche qui sopra inghiottiva ogni GET pubblica
// registrata più tardi — conferma/disiscrizione newsletter, pixel di
// tracciamento aperture, pagina di prenotazione chiamate — che finivano
// tutte in un redirect alla homepage.
export const publicCatchAllRouter = Router();

publicCatchAllRouter.get("/*", publicLimiter, resolveSite, async (req, res, next) => {
  if (req.path.startsWith("/admin") || req.path.startsWith("/api") || req.path.startsWith("/login")) {
    return next();
  }

  const siteId = req.site?.id;
  if (!siteId) {
    return res.status(404).send("Sito non trovato");
  }

  const layoutName = "layouts/" + resolveLayoutName(req.site?.layout_template);
  const themeVars = { ...(await getSiteThemeVars(siteId)) };

  const urlPath = req.path === "/" ? "/" : req.path.replace(/\/$/, "") || "/";

  // Locali SEO (canonical, OG/Twitter, JSON-LD) condivisi tra il branch
  // "pagina trovata direttamente" e quello "homepage via homepage_path" —
  // prima di questo helper, il secondo caso non riceveva ALCUN meta SEO
  // (nemmeno meta_title/meta_description), perché è un res.render separato
  // che non interrogava mai page_seo.
  async function buildSeoLocals(page, urlPath, isHomepage) {
    const seo = (await query(
      "SELECT meta_title, meta_description, meta_keywords, canonical_url, noindex, og_image FROM page_seo WHERE page_id = $1",
      [page.id]
    )).rows[0] || {};
    const baseUrl = await getCanonicalBaseUrl(siteId, { req });
    const siteSeo = await getSiteSeoConfig(siteId);
    const canonicalUrl = buildCanonicalUrl(baseUrl, urlPath, seo.canonical_url);
    const ogImage = toAbsoluteUrl(baseUrl, seo.og_image || siteSeo.defaultOgImage || "");
    const metaTitle = seo.meta_title || page.title;
    const metaDescription = seo.meta_description || "";
    const noindex = !!seo.noindex;
    const webpageJsonLd = noindex ? null : serializeJsonLd(buildWebPageJsonLd({
      name: metaTitle, description: metaDescription, url: canonicalUrl, image: ogImage || undefined,
    }));
    const websiteJsonLd = isHomepage
      ? serializeJsonLd(buildWebsiteJsonLd({ name: themeVars.brandName, url: baseUrl }))
      : null;
    return { meta_title: metaTitle, meta_description: metaDescription, meta_keywords: seo.meta_keywords || "", canonicalUrl, noindex, ogImage, twitterHandle: siteSeo.twitterHandle, brandName: themeVars.brandName, webpageJsonLd, websiteJsonLd };
  }

  try {
    // Cache breve sulle pagine pubbliche: cambiano solo su publish/export.
    // 5 min è un buon compromesso (TTFB + carico DB ridotto, contenuto fresco).
    res.setHeader("Cache-Control", "public, max-age=300");
    // 1. Redirect check (prima della pagina, per dare priorità ai redirect espliciti)
    const redirectResult = await query(
      "SELECT to_path, code FROM redirects WHERE site_id = $1 AND from_path = $2",
      [siteId, urlPath]
    );
    if (redirectResult.rows.length > 0) {
      const { to_path, code } = redirectResult.rows[0];
      return res.redirect(code, to_path);
    }

    // 2. Pagina pubblicata
    const result = await query(
      "SELECT id, title, content, layout_mode FROM pages WHERE site_id = $1 AND url_path = $2 AND published = true",
      [siteId, urlPath]
    );

    if (result.rows.length === 0) {
      if (urlPath === "/" && req.site?.homepage_path) {
        const homeResult = await query(
          "SELECT id, title, content, layout_mode FROM pages WHERE site_id = $1 AND url_path = $2 AND published = true",
          [siteId, req.site.homepage_path]
        );
        if (homeResult.rows.length > 0) {
          const page = homeResult.rows[0];
          const seoLocals = await buildSeoLocals(page, "/", true);
          const effectiveTracking = await getEffectiveTrackingConfig(siteId, page.id);
          const trackingLocals = { ...themeVars, ...effectiveTracking };
          if (page.layout_mode === "standalone") {
            if (seoLocals.noindex) res.setHeader("X-Robots-Tag", "noindex");
            let html = await expandSnippets(siteId, page.content);
            html = injectSeoIntoStandalone(html, seoLocals);
            html = injectTrackingIntoStandalone(html, await renderTrackingBlocks(trackingLocals));
            return res.send(html);
          }
          const renderedContent = await expandSnippets(siteId, page.content);
          return res.render(layoutName, {
            ...trackingLocals,
            title: page.title,
            content: renderedContent,
            ...seoLocals,
            layout: false,
          });
        }
      }
      if (urlPath === "/") {
        return res.render(layoutName, {
          ...themeVars,
          title: "",
          content: "",
          layout: false,
        });
      }
      return res.redirect("/");
    }

    const page = result.rows[0];

    const seoLocals = await buildSeoLocals(page, urlPath, urlPath === "/");
    const effectiveTracking = await getEffectiveTrackingConfig(siteId, page.id);
    const trackingLocals = { ...themeVars, ...effectiveTracking };

    // Tracciamento visita (fire-and-forget)
    query(
      "INSERT INTO page_views (page_id, referrer, session_id) VALUES ($1, $2, $3)",
      [page.id, req.headers.referer || null, req.cookies?.session_id || null]
    ).catch(() => {});

    if (page.layout_mode === "standalone") {
      if (seoLocals.noindex) res.setHeader("X-Robots-Tag", "noindex");
      let html = await expandSnippets(siteId, page.content);
      html = injectSeoIntoStandalone(html, seoLocals);
      html = injectTrackingIntoStandalone(html, await renderTrackingBlocks(trackingLocals));
      return res.send(html);
    }

    const renderedContent = await expandSnippets(siteId, page.content);
    res.render(layoutName, {
      ...trackingLocals,
      title: page.title,
      content: renderedContent,
      ...seoLocals,
      layout: false,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
