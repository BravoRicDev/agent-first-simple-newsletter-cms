import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { query } from "../db.js";
import { expandSnippets } from "./page-renderer.js";
import { logger } from "./logger.js";
import { resolveLayoutName, getSiteThemeVars } from "./site-render.js";
import { getSiteTrackingConfigMasked, getEffectiveTrackingConfig, renderTrackingBlocks, injectTrackingIntoStandalone } from "./tracking.js";
import { getSiteSeoConfig } from "./site-seo.js";
import {
  getPublishedPagesForSitemap, buildSitemapXml, buildRobotsTxt,
  buildCanonicalUrl, toAbsoluteUrl, buildWebsiteJsonLd, buildWebPageJsonLd, serializeJsonLd,
  injectSeoIntoStandalone,
} from "./seo.js";
import { getCanonicalBaseUrl } from "./urls.js";
import config from "../config.js";
import ejs from "ejs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATIC_ROOT = path.resolve(__dirname, "../../static");
export const VIEWS_DIR = path.resolve(__dirname, "../../views");

function urlPathToFilename(urlPath) {
  if (urlPath === "/" || urlPath === "") return "index.html";
  const clean = urlPath.replace(/^\//, "").replace(/\/$/, "");
  return clean + ".html";
}

function filenameToUrlPath(filename) {
  if (filename === "index.html") return "/";
  return "/" + filename.replace(/\.html$/, "");
}

export function getSiteStaticDir(siteId) {
  return path.join(STATIC_ROOT, String(siteId));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Locali SEO (canonical, OG/Twitter, JSON-LD) condivise tra le pagine
// "wrapped" (passate al layout EJS) e quelle "standalone" (dove i tag
// vengono cuciti nel <head> da injectSeoIntoStandalone, vedi sotto) —
// stessa logica di src/routes/serve.js, riadattata al contesto non-request
// dell'export statico (nessun req da cui leggere l'host).
function buildSeoLocals(page, urlPath, { baseUrl, siteSeo, brandName, isHomepage }) {
  const canonicalUrl = buildCanonicalUrl(baseUrl, urlPath, page.canonical_url);
  const ogImage = toAbsoluteUrl(baseUrl, page.og_image || siteSeo.defaultOgImage || "");
  const metaTitle = page.meta_title || page.title || "";
  const metaDescription = page.meta_description || "";
  const noindex = !!page.noindex;
  const webpageJsonLd = noindex ? null : serializeJsonLd(buildWebPageJsonLd({
    name: metaTitle, description: metaDescription, url: canonicalUrl, image: ogImage || undefined,
  }));
  const websiteJsonLd = isHomepage ? serializeJsonLd(buildWebsiteJsonLd({ name: brandName, url: baseUrl })) : null;
  return { meta_title: metaTitle, meta_description: metaDescription, meta_keywords: page.meta_keywords || "", canonicalUrl, noindex, ogImage, twitterHandle: siteSeo.twitterHandle, brandName, webpageJsonLd, websiteJsonLd };
}

async function exportPage(siteId, page, layoutName, themeVars, seoContext) {
  try {
    const layoutTemplate = path.join(VIEWS_DIR, "layouts", `${layoutName}.ejs`);
    const html = await expandSnippets(siteId, page.content || "");
    const seoLocals = seoContext
      ? buildSeoLocals(page, page.url_path, { ...seoContext, isHomepage: page.url_path === "/" })
      : {};
    // Calcola config tracking effettiva per questa pagina (merge sito + override pagina)
    const effectiveTracking = await getEffectiveTrackingConfig(siteId, page.id);
    const trackingLocals = { ...themeVars, ...effectiveTracking };

    let finalHtml;
    if (page.layout_mode === "wrapped") {
      finalHtml = await ejs.renderFile(layoutTemplate, {
        ...trackingLocals,
        title: page.title || "",
        content: html,
        ...seoLocals,
        meta_title: seoLocals.meta_title ?? (page.meta_title || page.title || ""),
        meta_description: seoLocals.meta_description ?? (page.meta_description || ""),
        layout: false,
        cache: false,
      });
    } else {
      // Standalone: HTML completo salvato nel content — i campi SEO gestiti
      // via API/DB vengono cuciti nel <head> (override non distruttivo: i
      // tag scritti a mano restano finché i campi sono vuoti). Serve.js usa
      // l'header X-Robots-Tag per noindex, ma i file statici passano da
      // Caddy senza Express: il meta robots nel markup è l'unica leva.
      // Stesso discorso per il tracking (GA4/banner consenso): Caddy non
      // passa da Express, quindi va iniettato nel markup esportato.
      finalHtml = injectSeoIntoStandalone(html, seoLocals);
      finalHtml = injectTrackingIntoStandalone(finalHtml, await renderTrackingBlocks(trackingLocals));
    }

    const filename = urlPathToFilename(page.url_path);
    const dir = getSiteStaticDir(siteId);
    const filePath = path.join(dir, filename);

    ensureDir(path.dirname(filePath));
    // Tmp univoco per export: process.pid da solo colliderebbe tra export
    // concorrenti della stessa pagina (stesso processo) — contenuto stantio
    // o corrotto con "last rename wins".
    const tmpPath = filePath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmpPath, finalHtml, "utf-8");
    fs.renameSync(tmpPath, filePath);

    return { ok: true, url_path: page.url_path, filename };
  } catch (err) {
    logger.error(`Export page failed: site=${siteId} url=${page.url_path}`, { error: err.message });
    return { ok: false, url_path: page.url_path, error: err.message };
  }
}

export async function deleteStaticPage(siteId, urlPath) {
  try {
    const filename = urlPathToFilename(urlPath);
    const filePath = path.join(getSiteStaticDir(siteId), filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Static file deleted: site=${siteId} url=${urlPath}`);
    }
    return { deleted: true, url_path: urlPath };
  } catch (err) {
    logger.error(`Delete static file failed: site=${siteId} url=${urlPath}`, { error: err.message });
    return { deleted: false, url_path: urlPath, error: err.message };
  }
}

function collectHtmlFilesRecursive(rootDir) {
  const result = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".html")) {
        result.push(path.relative(rootDir, full));
      }
    }
  }
  walk(rootDir);
  return result;
}

export async function cleanupOrphanedFiles(siteId, { hasHomepage = true } = {}) {
  const dir = getSiteStaticDir(siteId);
  if (!fs.existsSync(dir)) return { removed: [], count: 0 };

  const publishedPaths = new Set();
  const pages = (await query(
    "SELECT url_path FROM pages WHERE site_id = $1 AND published = true",
    [siteId]
  )).rows;
  for (const p of pages) {
    publishedPaths.add(urlPathToFilename(p.url_path));
  }

  const files = collectHtmlFilesRecursive(dir);
  const removed = [];
  for (const f of files) {
    // 404.html non dipende da alcuna pagina pubblicata con quel path, resta sempre.
    // index.html invece va ripulito se non risolve più a nessun contenuto valido
    // (né una pagina reale a "/" né homepage_path), altrimenti resterebbe stale
    // a tempo indeterminato mostrando contenuto cancellato/spubblicato.
    if (f === "404.html") continue;
    if (f === "index.html" && hasHomepage) continue;
    if (!publishedPaths.has(f)) {
      const filePath = path.join(dir, f);
      try {
        fs.unlinkSync(filePath);
        removed.push(f);
      } catch (e) {
        logger.error(`Cleanup failed: ${filePath}`, { error: e.message });
      }
    }
  }
  if (removed.length > 0) {
    logger.info(`Orphaned static files cleaned: site=${siteId} count=${removed.length}`);
  }
  // Rimuovi le directory rimaste vuote dopo la pulizia (es. /blog/post
  // cancellato lascia blog/ vuota per sempre).
  const dirs = [];
  (function collectEmptyDirs(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    let nonEmpty = false;
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        collectEmptyDirs(full);
        // Ricontrolla dopo la ricorsione (potrebbe essersi svuotata ora)
        if (fs.readdirSync(full).length === 0) dirs.push(full);
        else nonEmpty = true;
      } else {
        nonEmpty = true;
      }
    }
  })(dir);
  for (const d of dirs) {
    try { fs.rmdirSync(d); } catch { /* non vuota tra un check e l'altro */ }
  }
  return { removed, count: removed.length };
}

// baseUrl è già un URL completo ("https://dominio") risolto dal chiamante
// via getCanonicalBaseUrl — prima riceveva un dominio nudo e ricostruiva
// "https://" internamente usando sempre la colonna legacy sites.domain,
// disallineata da site_domains (la stessa fonte usata dal live-serving in
// serve.js), col rischio di sitemap/robots con un dominio diverso da quello
// servito davvero.
export async function generateSeoFiles(siteId, baseUrl) {
  if (!baseUrl) return { ok: false, error: "Dominio non configurato" };
  try {
    const pages = await getPublishedPagesForSitemap(siteId);
    const siteSeo = await getSiteSeoConfig(siteId);
    const dir = getSiteStaticDir(siteId);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, "sitemap.xml"), buildSitemapXml(baseUrl, pages), "utf-8");
    fs.writeFileSync(path.join(dir, "robots.txt"), buildRobotsTxt(baseUrl, siteSeo.robotsExtra), "utf-8");
    return { ok: true };
  } catch (err) {
    logger.error(`SEO files generation failed: site=${siteId}`, { error: err.message });
    return { ok: false, error: err.message };
  }
}

export async function generate404Page(siteId) {
  try {
    const site = (await query("SELECT id, homepage_path, layout_template FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!site) return { ok: false, error: "Sito non trovato" };
    const layoutName = resolveLayoutName(site.layout_template);
    const themeVars = { ...(await getSiteThemeVars(siteId)) };

    const targetPath = site.homepage_path || "/";
    const pages = (await query(
      `SELECT p.id, p.url_path, p.title, p.content, p.layout_mode,
              COALESCE(s.meta_title, p.title) AS meta_title,
              COALESCE(s.meta_description, '') AS meta_description,
              s.canonical_url, s.og_image
       FROM pages p
       LEFT JOIN page_seo s ON s.page_id = p.id
       WHERE p.site_id = $1 AND p.url_path = $2 AND p.published = true`,
      [siteId, targetPath]
    )).rows;

    if (pages.length === 0) return { ok: false, error: "Homepage page not found" };

    const page = pages[0];
    const html = await expandSnippets(siteId, page.content || "");
    // Usa override tracking della pagina di base (homepage) per la 404
    const effectiveTracking = await getEffectiveTrackingConfig(siteId, page.id);
    const trackingLocals = { ...themeVars, ...effectiveTracking };

    // La pagina 404 non deve MAI essere indicizzata, indipendentemente da
    // cosa dice page_seo per il contenuto che ne ha ispirato il markup
    // (riusa il layout/testo dell'homepage come base visiva, ma è pur
    // sempre una pagina d'errore).
    let finalHtml;
    if (page.layout_mode === "wrapped") {
      const layoutTemplate = path.join(VIEWS_DIR, "layouts", `${layoutName}.ejs`);
      const baseUrl = await getCanonicalBaseUrl(siteId);
      const siteSeo = await getSiteSeoConfig(siteId);
      const seoLocals = buildSeoLocals(page, "/404", { baseUrl, siteSeo, brandName: themeVars.brandName, isHomepage: false });
      finalHtml = await ejs.renderFile(layoutTemplate, {
        ...trackingLocals,
        title: page.title || "",
        content: html,
        ...seoLocals,
        noindex: true,
        webpageJsonLd: null,
        layout: false,
        cache: false,
      });
    } else {
      // La pagina 404 standalone: noindex forzato (mai indicizzabile) ma
      // nessun altro tag SEO (è una pagina d'errore, non un contenuto).
      // Il tracking invece sì: la 404 wrapped passa dal layout che include
      // i partial, quindi anche la standalone deve avere GA4/banner.
      finalHtml = injectSeoIntoStandalone(html, { noindex: true });
      finalHtml = injectTrackingIntoStandalone(finalHtml, await renderTrackingBlocks(trackingLocals));
    }

    const dir = getSiteStaticDir(siteId);
    const filePath = path.join(dir, "404.html");
    ensureDir(dir);
    fs.writeFileSync(filePath, finalHtml, "utf-8");

    return { ok: true, path: filePath };
  } catch (err) {
    logger.error(`404 page generation failed: site=${siteId}`, { error: err.message });
    return { ok: false, error: err.message };
  }
}

// Mutex in-process per sito: il tick dello scheduler (fullExport, ogni 5
// tick) e le route manuali (/admin/export-static, agent export) possono
// partire in parallelo; senza lock createSymlinks/cleanupOrphanedFiles
// riscrivevano/cancellavano file mentre un altro export era in corso.
const exportLocks = new Set();

export async function exportPublishedPages({ siteId, pageIds = null }) {
  if (!config.staticExportEnabled) {
    logger.debug("Static export disabled via config");
    return { site_id: siteId, exported: 0, errors: 0, results: [] };
  }
  if (exportLocks.has(siteId)) {
    logger.warn(`Static export: export già in corso per site ${siteId}, salto questo giro`);
    return { site_id: siteId, exported: 0, errors: 0, results: [], skipped: true };
  }
  exportLocks.add(siteId);
  try {
    return await exportPublishedPagesInner(siteId, pageIds);
  } catch (err) {
    // Chiamata quasi sempre "fire and forget" dalle route (.catch(() => {}))
    // dopo aver già risposto al client: senza questo log un errore qui
    // (es. DB irraggiungibile) spariva senza lasciare traccia. Rilanciamo
    // comunque l'errore: deploy.js e la route /admin/export-static si
    // aspettano un throw (o results.errors) per segnalare un export fallito.
    logger.error(`Export failed: site=${siteId}`, { error: err.message });
    throw err;
  } finally {
    exportLocks.delete(siteId);
  }
}

async function exportPublishedPagesInner(siteId, pageIds) {
  let sql = `
    SELECT p.id, p.url_path, p.title, p.content, p.layout_mode,
           COALESCE(s.meta_title, p.title) AS meta_title,
           COALESCE(s.meta_description, '') AS meta_description,
           s.meta_keywords, s.canonical_url, s.noindex, s.og_image
    FROM pages p
    LEFT JOIN page_seo s ON s.page_id = p.id
    WHERE p.site_id = $1 AND p.published = true
  `;
  const params = [siteId];
  if (pageIds && pageIds.length > 0) {
    sql += ` AND p.id = ANY($${params.length + 1}::int[])`;
    params.push(pageIds);
  }
  sql += " ORDER BY p.url_path";

  const pages = (await query(sql, params)).rows;
  if (pages.length === 0) {
    // Cancella index/404 SOLO se è un export completo (pageIds == null) e il sito
    // ha davvero zero pagine pubblicate. Con pageIds specificati (es. export dopo
    // creazione/update di una bozza), 0 righe significa solo "la pagina filtrata
    // non è pubblicata": cancellare index.html/404.html farebbe sparire la
    // homepage statica dell'intero sito anche se ci sono altre pagine pubblicate.
    if (!pageIds || pageIds.length === 0) {
      await cleanupOrphanedFiles(siteId);
      const dir = getSiteStaticDir(siteId);
      for (const f of ["index.html", "404.html"]) {
        const fp = path.join(dir, f);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
      }
    }
    return { site_id: siteId, exported: 0, errors: 0, results: [] };
  }

  const site = (await query("SELECT id, domain, homepage_path, layout_template FROM sites WHERE id = $1", [siteId])).rows[0];
  const layoutName = resolveLayoutName(site?.layout_template);
  const themeVars = { ...(await getSiteThemeVars(siteId)), ...(await getSiteTrackingConfigMasked(siteId)) };
  const baseUrl = await getCanonicalBaseUrl(siteId);
  const siteSeo = await getSiteSeoConfig(siteId);
  const seoContext = { baseUrl, siteSeo, brandName: themeVars.brandName };

  const results = [];
  for (const page of pages) {
    const r = await exportPage(siteId, page, layoutName, themeVars, seoContext);
    results.push(r);
  }

  // homepage_path è solo un fallback: se esiste una pagina reale pubblicata a
  // "/", quella vince sempre — stessa priorità già applicata dal rendering
  // live in serve.js. Altrimenti live e statico mostrerebbero home diverse.
  const hasRealRootPage = pages.some(p => p.url_path === "/");
  if (!hasRealRootPage && site?.homepage_path && site.homepage_path !== "/") {
    const homePage = pages.find(p => p.url_path === site.homepage_path);
    if (homePage) {
      const r = await exportPage(siteId, { ...homePage, url_path: "/" }, layoutName, themeVars, seoContext);
      results.push(r);
    }
  }

  await cleanupOrphanedFiles(siteId, { hasHomepage: hasRealRootPage || (!!site?.homepage_path && pages.some(p => p.url_path === site.homepage_path)) });
  await generate404Page(siteId);
  await generateSeoFiles(siteId, baseUrl);

  const exported = results.filter(r => r.ok).length;
  const errors = results.filter(r => !r.ok);

  return { site_id: siteId, exported, errors: errors.length, results };
}

export async function exportAllSites() {
  const sites = (await query(
    "SELECT id, name, domain, homepage_path FROM sites WHERE id IN (SELECT DISTINCT site_id FROM pages WHERE published = true) ORDER BY id"
  )).rows;

  const all = [];
  for (const site of sites) {
    const r = await exportPublishedPages({ siteId: site.id });
    all.push(r);
    logger.info(`Export site ${site.id} (${site.name}): ${r.exported} pages${r.errors ? `, ${r.errors} errors` : ""}`);
  }
  return all;
}

export async function createSymlinks() {
  const domains = (await query(
    "SELECT site_id, domain FROM site_domains ORDER BY site_id, domain"
  )).rows;
  const currentDomains = new Set(domains.map(d => d.domain));

  // Rimuovi symlink orfani (domini cancellati)
  if (fs.existsSync(STATIC_ROOT)) {
    const entries = fs.readdirSync(STATIC_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (e.isSymbolicLink() && !currentDomains.has(e.name)) {
        try {
          fs.unlinkSync(path.join(STATIC_ROOT, e.name));
        } catch (err) {
          logger.error(`Symlink cleanup failed: ${e.name}`, { error: err.message });
        }
      }
    }
  }

  let count = 0;
  for (const d of domains) {
    const targetDir = getSiteStaticDir(d.site_id);
    const linkDir = path.join(STATIC_ROOT, d.domain);

    if (!fs.existsSync(targetDir)) continue;

    try {
      if (fs.existsSync(linkDir)) {
        const stat = fs.lstatSync(linkDir);
        if (stat.isSymbolicLink()) {
          const current = fs.readlinkSync(linkDir);
          if (current === String(d.site_id)) continue;
          fs.unlinkSync(linkDir);
        } else if (stat.isDirectory()) {
          continue;
        }
      }
      fs.symlinkSync(String(d.site_id), linkDir, "dir");
      count++;
    } catch (err) {
      if (err.code !== "EEXIST") {
        logger.error(`Symlink failed: ${d.domain} → ${d.site_id}`, { error: err.message });
      }
    }
  }
  return count;
}

export async function fullExport() {
  if (!config.staticExportEnabled) {
    logger.debug("Static export disabled via config");
    return { sites: [], totalExported: 0, totalErrors: 0, symlinkCount: 0 };
  }
  logger.info("Static export: starting full export");
  const results = await exportAllSites();
  const symlinkCount = await createSymlinks();
  const totalExported = results.reduce((s, r) => s + r.exported, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  logger.info(`Static export: ${totalExported} pages, ${totalErrors} errors, ${symlinkCount} symlinks`);
  return { sites: results, totalExported, totalErrors, symlinkCount };
}
