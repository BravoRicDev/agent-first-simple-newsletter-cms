import { Router } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { execFile } from "child_process";
import { promisify } from "util";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { expandSnippets } from "../services/page-renderer.js";
import { auditLog } from "../services/audit.js";
import { z } from "zod";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const archiver = require("archiver");
import { diffLines } from "diff";
import { getSiteDir, ensureSiteDir, fetchUrlToMedia, saveBufferToMedia, compressVideo, verifyMagicBytes } from "./media.js";
import { buildChangelogMessage } from "../services/changelog.js";
import { exportPublishedPages, deleteStaticPage, fullExport } from "../services/static-export.js";
import { reminderMiddleware } from "../services/agent-reminder.js";
import { extractAndReplaceBase64 } from "../services/media-utils.js";
import { aggregateContacts, getContactTimeline, searchSubmissions, setContactFields, getContactRecord, listTags, getPipelineBoard } from "../services/contacts.js";
import { exportContactData, eraseContactData } from "../services/privacy.js";
import { listEnabledModules, isModuleEnabled } from "../middleware/modules.js";
import { MODULES, MODULE_KEYS } from "../constants/modules.js";
import { PIPELINE_STAGES } from "../constants/pipeline.js";
import {
  listUpcomingCalls, listCallsForContact, scheduleCallManually, setCallOutcome,
  getAvailabilityRules, setAvailabilityRules, computeAvailableSlots, bookCall,
  listCalendars, getCalendar, createCalendar, updateCalendar, deleteCalendar,
} from "../services/calls.js";
import { getSiteTrackingConfigMasked, setSiteTrackingConfig, getPageTrackingOverride, setPageTrackingOverride } from "../services/tracking.js";
import { getSiteSeoConfig, setSiteSeoConfig } from "../services/site-seo.js";
import { formatBytes, formatKb, formatMb } from "../services/format.js";
import { normalizeUrlPath } from "../services/urls.js";
import { sanitizeSvgFileIfNeeded } from "../services/svg-sanitize.js";
import { getSiteEmailConfig, resetSiteTransporter } from "../services/email.js";
import { EMAIL_TEMPLATE_KINDS, listEmailTemplates, setEmailTemplate, deleteEmailTemplate } from "../services/email-templates.js";
import { readLocaleMarkdown } from "../middleware/i18n.js";
import { sendConfirmationEmail, sendTestEmail } from "../services/newsletter.js";
import { getComplaintMetrics } from "../services/complaints.js";
import { verifySubscriberEmail } from "../services/email-verify.js";
import { logger } from "../services/logger.js";
import config from "../config.js";

const execFileAsync = promisify(execFile);

const router = Router();

import { Worker } from "worker_threads";

const REGEX_RUN_TIMEOUT_MS = 1000;

// Esegue una regex in un worker thread. Il vecchio withRegexTimeout era
// finto: fn() era sincrona, quindi durante un backtracking catastrofico
// l'event loop era bloccato e il setTimeout non poteva MAI scattare — il
// server si congelava per la durata reale dell'esecuzione. Nel worker il
// main può fare terminate() dopo il timeout, uccidendo il thread anche a
// backtracking in corso (reachable via MCP find-replace con regex ReDoS).
function runRegexInWorker({ pattern, flags, content, replace, mode }) {
  return new Promise((resolve) => {
    let settled = false;
    let worker;
    try {
      worker = new Worker(new URL("../services/regex-worker.js", import.meta.url), {
        workerData: { pattern, flags, content, replace, mode },
      });
    } catch {
      resolve({ timedOut: false, result: null });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      resolve({ timedOut: true, result: null });
    }, REGEX_RUN_TIMEOUT_MS);
    worker.on("message", (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(msg && msg.ok ? { timedOut: false, result: msg.result } : { timedOut: false, result: null });
    });
    worker.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, result: null });
    });
    worker.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, result: null });
    });
  });
}

// parseInt su query param: "abc" → NaN → LIMIT NaN → errore Postgres → 500.
// Questo helper restituisce il fallback quando il valore non è un intero >= 0.
const parseIntParam = (value, fallback = 0) => {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

// Auto-reminder: ogni ~12 chiamate include _reminder nella risposta JSON
router.use("/api/agent", reminderMiddleware);

export function requireAgent(req, res, next) {
  if (!req.user?.agent) {
    return res.status(403).json({ error: res.locals.t("api.auth.agentOnlyEndpoint") });
  }
  next();
}

async function canAccessSite(user, siteId) {
  const sid = parseInt(siteId, 10);
  if (!Number.isInteger(sid) || sid < 1) return false;
  if (user.role === "superadmin") return true;
  return user.site_id === sid;
}

// Sanitizzazione definizioni quiz (stessa logica di routes/quizzes.js ma
// senza dipendenza circolare): domande con opzioni label/punti, soglie
// ordinate per min.
function sanitizeQuizQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const used = new Set();
  return raw
    .filter(q => q && typeof q.label === "string" && q.label.trim())
    .slice(0, 30)
    .map((q, i) => {
      const label = q.label.trim().slice(0, 255);
      let key = String(q.key || label)
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100) || `domanda_${i + 1}`;
      let unique = key;
      let n = 2;
      while (used.has(unique)) unique = `${key}_${n++}`;
      used.add(unique);
      const options = Array.isArray(q.options)
        ? q.options
            .filter(o => o && typeof o.label === "string" && o.label.trim())
            .slice(0, 12)
            .map(o => ({
              label: o.label.trim().slice(0, 255),
              points: Number.isFinite(Number(o.points)) ? Number(o.points) : 0,
            }))
        : [];
      return { key: unique, label, options };
    });
}

function sanitizeQuizThresholds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(x => x && x.title !== undefined && x.title !== null && String(x.title).trim())
    .slice(0, 20)
    .map(x => ({
      min: Number.isFinite(Number(x.min)) ? Number(x.min) : 0,
      // max null/undefined/stringa vuota = open-ended. Number(null) === 0,
      // quindi il check DEVE venire prima della conversione numerica.
      max: (x.max === null || x.max === undefined || x.max === "") ? null : (Number.isFinite(Number(x.max)) ? Number(x.max) : null),
      title: String(x.title).trim().slice(0, 255),
      message: String(x.message || "").trim().slice(0, 2000),
      class: ["ok", "warn", "cold"].includes(x.class) ? x.class : "",
    }))
    .sort((a, b) => a.min - b.min);
}

// ── Me ─────────────────────────────────────────────────────────────────────

router.get("/api/agent/me", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const result = await query(
      "SELECT id, email, name, role, site_id, status, token_version FROM users WHERE id = $1",
      [req.user.sub]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: res.locals.t("api.common.userNotFound") });
    const user = result.rows[0];
    // I token API (api_tokens) non hanno `exp` — solo i JWT di sessione. Evita
    // RangeError: Invalid Date su new Date(undefined).toISOString().
    const tokenExpiresAt = req.user.exp ? new Date(req.user.exp * 1000).toISOString() : null;
    res.json({
      user,
      token_expires_at: tokenExpiresAt,
    });
  } catch (err) { next(err); }
});

// ── Siti ───────────────────────────────────────────────────────────────────

router.get("/api/agent/sites", requireAuth, requireAgent, async (req, res, next) => {
  try {
    let sites;
    if (req.user.role === "superadmin") {
      sites = (await query(
        "SELECT id, name, domain, layout_template FROM sites ORDER BY name"
      )).rows;
    } else if (req.user.site_id) {
      sites = (await query(
        "SELECT id, name, domain, layout_template FROM sites WHERE id = $1",
        [req.user.site_id]
      )).rows;
    } else {
      sites = [];
    }
    res.json({ sites });
  } catch (err) { next(err); }
});

// ── Pagine — search, scheduled e bulk (PRIMA di :pageId) ──────────────────

router.get("/api/agent/sites/:siteId/pages/scheduled", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      `SELECT id, url_path, title, publish_at, created_at
       FROM pages WHERE site_id = $1 AND publish_at IS NOT NULL AND published = false
       ORDER BY publish_at ASC`,
      [siteId]
    )).rows;

    res.json({ scheduled: rows });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/pages/search", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const q = req.query.q?.trim();
    if (!q || q.length < 2) return res.status(400).json({ error: res.locals.t("api.pages.searchQueryRequired") });

    const rows = (await query(
      `SELECT id, url_path, title, published, updated_at,
              LEFT(content, 200) AS content_preview
       FROM pages
       WHERE site_id = $1 AND (content ILIKE $2 OR title ILIKE $2)
       ORDER BY updated_at DESC`,
      [siteId, `%${q}%`]
    )).rows;

    res.json({ results: rows, query: q });
  } catch (err) { next(err); }
});

const bulkPublishSchema = z.object({
  page_ids: z.array(z.number().int().positive()).min(1).max(50),
  published: z.boolean(),
});

router.post("/api/agent/sites/:siteId/pages/bulk-publish", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const { page_ids, published } = bulkPublishSchema.parse(req.body);

    const placeholders = page_ids.map((_, i) => `$${i + 3}`).join(",");
    const result = await query(
      `UPDATE pages SET published = $1, updated_at = NOW()
       WHERE site_id = $2 AND id IN (${placeholders})
       RETURNING id, url_path, published`,
      [published, siteId, ...page_ids]
    );

    res.json({ updated: result.rows, count: result.rowCount });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});



// ── Pagine ─────────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }
    const allowedFields = ["id", "url_path", "title", "layout_mode", "published", "created_at", "updated_at"];
    const fields = req.query.fields
      ? req.query.fields.split(",").filter(f => allowedFields.includes(f.trim()))
      : allowedFields;
    if (fields.length === 0) return res.status(400).json({ error: res.locals.t("api.pages.noValidFieldsRequested") });
    const pages = (await query(
      `SELECT ${fields.join(", ")} FROM pages WHERE site_id = $1 ORDER BY url_path`,
      [siteId]
    )).rows;
    res.json({ pages });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/pages/:pageId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }
    const result = await query(
      "SELECT * FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });
    res.json({ page: result.rows[0] });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/pages/:pageId/summary", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const page = (await query(
      "SELECT id, url_path, title, layout_mode, published, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const content = page.content || "";
    const b64Matches = [...content.matchAll(/data:(image|font)\/[a-zA-Z0-9+.-]+;base64,([A-Za-z0-9+/=]{20,})/g)];
    // m[2] è la stringa base64 reale; m[1] è solo il tipo ("image"/"font") — 4-5 char
    const totalB64Size = b64Matches.reduce((s, m) => s + Math.floor(m[2].length * 0.75), 0);
    const snippetTags = [...new Set([...content.matchAll(/\{\{snippet:([a-zA-Z0-9_-]+)\}\}/g)].map(m => m[1]))];
    const varTags = [...new Set([...content.matchAll(/\{\{var:([a-zA-Z0-9_-]+)\}\}/g)].map(m => m[1]))];
    const extUrls = [...new Set([...content.matchAll(/https?:\/\/[^"'\s>)]+/g)].map(m => m[0]))];
    const mediaUrls = extUrls.filter(u => /\/media\/\d+\//.test(u));

    res.json({
      page_id: page.id,
      url_path: page.url_path,
      title: page.title,
      layout_mode: page.layout_mode,
      published: page.published,
      content_size_kb: Math.round(content.length / 1024),
      content_size_formatted: formatKb(Math.round(content.length / 1024)),
      char_count: content.length,
      word_count: content.split(/\s+/).filter(Boolean).length,
      base64_count: b64Matches.length,
      base64_size_kb: Math.round(totalB64Size / 1024),
      base64_size_formatted: formatKb(Math.round(totalB64Size / 1024)),
      snippet_tags: snippetTags,
      variable_tags: varTags,
      external_urls: extUrls.length,
      media_urls: mediaUrls.length,
    });
  } catch (err) { next(err); }
});

// Endpoint atomico dedicato (invece di infilare questi campi nel PUT
// dell'intera pagina, che AGENT.md sconsiglia già per il contenuto): non
// richiede rispedire url_path/content/layout_mode solo per cambiare un meta
// tag. Effetto reale sul rendering per TUTTI i layout_mode: le pagine
// "wrapped" ricevono i tag dal layout EJS; le "standalone" li ricevono
// cuciti nel <head> da injectSeoIntoStandalone (serve.js + static-export.js),
// con override non distruttivo — un campo vuoto lascia intatto il tag
// scritto a mano nel template.
router.get("/api/agent/sites/:siteId/pages/:pageId/seo", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query("SELECT id, layout_mode FROM pages WHERE id = $1 AND site_id = $2", [req.params.pageId, siteId])).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const seo = (await query(
      "SELECT meta_title, meta_description, meta_keywords, canonical_url, noindex, og_image FROM page_seo WHERE page_id = $1",
      [page.id]
    )).rows[0] || { meta_title: null, meta_description: null, meta_keywords: null, canonical_url: null, noindex: false, og_image: null };

    res.json({ page_id: page.id, layout_mode: page.layout_mode, ...seo });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/pages/:pageId/seo", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query("SELECT id FROM pages WHERE id = $1 AND site_id = $2", [req.params.pageId, siteId])).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const { meta_title, meta_description, meta_keywords, canonical_url, og_image } = req.body;
    const noindex = typeof req.body.noindex === "boolean" ? req.body.noindex : req.body.noindex === "true";

    const seo = (await query(
      `INSERT INTO page_seo (page_id, meta_title, meta_description, meta_keywords, canonical_url, noindex, og_image, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, false), $7, NOW())
       ON CONFLICT (page_id) DO UPDATE
       SET meta_title = COALESCE($2, page_seo.meta_title),
           meta_description = COALESCE($3, page_seo.meta_description),
           meta_keywords = COALESCE($4, page_seo.meta_keywords),
           canonical_url = COALESCE($5, page_seo.canonical_url),
           noindex = COALESCE($6, page_seo.noindex),
           og_image = COALESCE($7, page_seo.og_image),
           updated_at = NOW()
       RETURNING meta_title, meta_description, meta_keywords, canonical_url, noindex, og_image`,
      [page.id, meta_title ?? null, meta_description ?? null, meta_keywords ?? null, canonical_url ?? null,
       "noindex" in req.body ? noindex : null, og_image ?? null]
    )).rows[0];

    res.json({ page_id: page.id, ...seo });
    exportPublishedPages({ siteId, pageIds: [page.id] }).catch(() => {});
  } catch (err) { next(err); }
});

const agentPageSchema = z.object({
  url_path: z.string().min(1),
  title: z.string().optional().default(""),
  content: z.string().optional().default(""),
  layout_mode: z.enum(["standalone", "wrapped"]).optional().default("wrapped"),
  published: z.boolean().optional().default(false),
  publish_at: z.string().datetime({ offset: true }).nullable().optional(),
});

router.post("/api/agent/sites/:siteId/pages", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }
    const data = agentPageSchema.parse(req.body);
    data.url_path = normalizeUrlPath(data.url_path);

    const publishAt = data.publish_at ? new Date(data.publish_at) : null;
    const effectivePublished = publishAt ? false : data.published;

    const result = await query(
      `INSERT INTO pages (site_id, url_path, title, content, layout_mode, published, publish_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [siteId, data.url_path, data.title, data.content, data.layout_mode, effectivePublished, publishAt]
    );
    const page = result.rows[0];

    // Auto-extract base64 inline (sempre, senza soglia)
    const { content: finalContent, converted: b64converted } = extractAndReplaceBase64(siteId, page.content);
    if (b64converted > 0) {
      await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [finalContent, page.id]);
      page.content = finalContent;
    }

    await auditLog({
      userId: req.user.sub,
      siteId,
      entityType: "page",
      entityId: page.id,
      action: "create",
      newData: { url_path: page.url_path, title: page.title, source: "agent" },
      ipAddress: req.ip,
    });

    res.status(201).json({ page });
    exportPublishedPages({ siteId, pageIds: [page.id] }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.message === "URL non valido") return res.status(400).json({ error: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

router.put("/api/agent/sites/:siteId/pages/:pageId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }
    const existing = (await query(
      "SELECT * FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!existing) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const data = agentPageSchema.parse(req.body);
    data.url_path = normalizeUrlPath(data.url_path);

    const publishAt = data.publish_at ? new Date(data.publish_at) : null;
    const effectivePublished = publishAt ? false : data.published;

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [existing.id, req.user.sub, existing.url_path, existing.title, existing.content, existing.layout_mode, existing.published]
    );

    const result = await query(
      `UPDATE pages SET url_path = $1, title = $2, content = $3, layout_mode = $4,
       published = $5, publish_at = $6, updated_at = NOW() WHERE id = $7 AND site_id = $8 RETURNING *`,
      [data.url_path, data.title, data.content, data.layout_mode, effectivePublished, publishAt, req.params.pageId, siteId]
    );

    const updatedPage = result.rows[0];

    // Auto-extract base64 inline dopo l'update
    const { content: finalContent, converted: b64converted } = extractAndReplaceBase64(siteId, data.content);
    if (b64converted > 0) {
      await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [finalContent, req.params.pageId]);
      updatedPage.content = finalContent;
    }

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: existing.id,
      action: "update",
      oldData: { url_path: existing.url_path, title: existing.title, source: "agent" },
      newData: { url_path: data.url_path, title: data.title, publish_at: data.publish_at },
      ipAddress: req.ip,
    });

    res.json({ page: updatedPage });
    exportPublishedPages({ siteId, pageIds: [existing.id] }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.message === "URL non valido") return res.status(400).json({ error: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

// ── Pagine — azioni atomiche ───────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/:pageId/publish-toggle", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const existing = (await query(
      "SELECT id, url_path, published FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!existing) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const newPublished = typeof req.body.published === "boolean"
      ? req.body.published
      : !existing.published;

    const result = await query(
      "UPDATE pages SET published = $1, updated_at = NOW() WHERE id = $2 RETURNING id, url_path, published",
      [newPublished, existing.id]
    );
    res.json({ page: result.rows[0] });
    if (newPublished) {
      exportPublishedPages({ siteId }).catch(() => {});
    } else {
      deleteStaticPage(siteId, existing.url_path).catch(() => {});
    }
  } catch (err) { next(err); }
});

const duplicateSchema = z.object({
  new_url_path: z.string().min(1),
  new_title: z.string().optional(),
});

const bulkDuplicateSchema = z.object({
  pages: z.array(z.object({
    page_id: z.number().int().positive(),
    new_url_path: z.string().min(1),
    new_title: z.string().optional(),
  })).min(1).max(50),
});

router.post("/api/agent/sites/:siteId/pages/bulk-duplicate", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { pages } = bulkDuplicateSchema.parse(req.body);
    const created = [];
    const errors = [];

    for (const item of pages) {
      try {
        const source = (await query("SELECT * FROM pages WHERE id = $1 AND site_id = $2", [item.page_id, siteId])).rows[0];
        if (!source) { errors.push({ page_id: item.page_id, error: res.locals.t("api.pages.notFound") }); continue; }

        const newPath = normalizeUrlPath(item.new_url_path);
        const newTitle = item.new_title || source.title + " (copia)";

        const result = await query(
          "INSERT INTO pages (site_id, url_path, title, content, layout_mode, published) VALUES ($1, $2, $3, $4, $5, false) RETURNING *",
          [siteId, newPath, newTitle, source.content, source.layout_mode]
        );

        created.push({ page_id: item.page_id, new_page: result.rows[0] });
      } catch (e) {
        // Non esporre e.message grezzo: può contenere dettagli DB (nome
        // indice/constraint). 23505 = url_path duplicato → messaggio dedicato.
        errors.push({ page_id: item.page_id, error: e.code === "23505" ? res.locals.t("api.pages.urlExists") : res.locals.t("api.common.internalError") });
      }
    }

    if (created.length > 0) {
      await auditLog({
        userId: req.user.sub, siteId,
        entityType: "page", entityId: null,
        action: "bulk-duplicate",
        newData: { created: created.map(c => ({ id: c.new_page.id, url_path: c.new_page.url_path })) },
        ipAddress: req.ip,
      });
    }

    res.json({ created, errors });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

router.post("/api/agent/sites/:siteId/pages/:pageId/duplicate", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const source = (await query(
      "SELECT * FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!source) return res.status(404).json({ error: res.locals.t("api.pages.sourcePageNotFound") });

    const data = duplicateSchema.parse(req.body);
    const newPath = normalizeUrlPath(data.new_url_path);
    const newTitle = data.new_title || source.title + " (copia)";

    const result = await query(
      `INSERT INTO pages (site_id, url_path, title, content, layout_mode, published)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING *`,
      [siteId, newPath, newTitle, source.content, source.layout_mode]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: result.rows[0].id,
      action: "create",
      newData: { url_path: newPath, duplicated_from: source.id, source: "agent" },
      ipAddress: req.ip,
    });

    res.status(201).json({ page: result.rows[0] });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.message === "URL non valido") return res.status(400).json({ error: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

const renameUrlSchema = z.object({
  new_url_path: z.string().min(1),
});

router.post("/api/agent/sites/:siteId/pages/:pageId/rename-url", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, url_path FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const { new_url_path } = renameUrlSchema.parse(req.body);
    const newPath = normalizeUrlPath(new_url_path);

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [page.id, req.user.sub]
    );

    const result = await query(
      "UPDATE pages SET url_path = $1, updated_at = NOW() WHERE id = $2 RETURNING id, url_path, title, published",
      [newPath, page.id]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: page.id,
      action: "update",
      oldData: { url_path: page.url_path, source: "agent" },
      newData: { url_path: newPath },
      ipAddress: req.ip,
    });

    res.json({ page: result.rows[0] });
    deleteStaticPage(siteId, page.url_path).catch(() => {});
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.message === "URL non valido") return res.status(400).json({ error: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

const findReplaceSchema = z.object({
  find: z.string().min(1),
  replace: z.string(),
  regex: z.boolean().optional().default(false),
  flags: z.string().regex(/^[gimsuy]*$/, "Flag non validi").optional().default("g"),
});

router.post("/api/agent/sites/:siteId/pages/:pageId/find-replace", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const { find, replace, regex, flags } = findReplaceSchema.parse(req.body);

    if (regex && find.length > 100) {
      return res.status(400).json({ error: res.locals.t("api.common.regexTooLong") });
    }

    let patternSource;
    let patternFlags;
    try {
      patternSource = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patternFlags = regex ? flags : "g";
      new RegExp(patternSource, patternFlags);
    } catch {
      return res.status(400).json({ error: res.locals.t("api.common.invalidRegexExpr") });
    }

    const { timedOut: matchTimedOut, result: matchesArray } = await runRegexInWorker({ pattern: patternSource, flags: patternFlags, content: page.content, mode: "match" });
    if (matchTimedOut) {
      return res.status(400).json({ error: res.locals.t("api.common.regexTimeout") });
    }
    // match() ritorna null quando non ci sono occorrenze (NON è un timeout)
    if (matchesArray === null) return res.json({ matches: 0, message: res.locals.t("api.pages.noMatchFound") });
    const matches = matchesArray.length;

    const versionResult = await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1
       RETURNING id`,
      [page.id, req.user.sub]
    );

    const { timedOut: replaceTimedOut, result: newContent } = await runRegexInWorker({ pattern: patternSource, flags: patternFlags, content: page.content, replace, mode: "replace" });
    if (replaceTimedOut) {
      return res.status(400).json({ error: res.locals.t("api.common.regexTimeout") });
    }
    // Il worker risolve result:null anche quando fallisce (ok:false, errore,
    // exit): scriverlo farebbe content = NULL e PERDEREBBE la pagina.
    if (typeof newContent !== "string") {
      return res.status(500).json({ error: res.locals.t("api.common.internalError") });
    }
    await query(
      "UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2",
      [newContent, page.id]
    );

    res.json({ matches, message: res.locals.t("api.pages.replacedOccurrences", { n: matches }), saved_version_id: versionResult.rows[0]?.id });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Cross-site search ─────────────────────────────────────────────────────

router.post("/api/agent/pages/search", requireAuth, requireAgent, async (req, res, next) => {
  try {
    // Schema: prima non c'era — site_ids con valori non interi (["abc"])
    // faceva 500 (cast int[]), array enormi → query ANY + loop per sito
    // (DoS), q senza max → ILIKE su contenuti enormi.
    const searchSchema = z.object({
      q: z.string().min(2).max(200),
      site_ids: z.array(z.number().int().positive()).max(100).optional(),
    });
    const { q, site_ids } = searchSchema.parse(req.body);
    if (!q || q.trim().length < 2) return res.status(400).json({ error: res.locals.t("api.pages.searchQueryRequired") });

    let sites;
    if (Array.isArray(site_ids) && site_ids.length > 0) {
      if (req.user.role === "superadmin") {
        sites = (await query("SELECT id, name FROM sites WHERE id = ANY($1::int[])", [site_ids])).rows;
      } else {
        sites = site_ids.filter(id => id === req.user.site_id).map(id => ({ id }));
      }
    } else {
      if (req.user.role === "superadmin") {
        sites = (await query("SELECT id, name FROM sites ORDER BY name")).rows;
      } else if (req.user.site_id) {
        sites = (await query("SELECT id, name FROM sites WHERE id = $1", [req.user.site_id])).rows;
      } else {
        sites = [];
      }
    }

    if (sites.length === 0) return res.json({ results: [], total: 0 });

    const allResults = [];
    const likeParam = `%${q.trim()}%`;

    for (const site of sites) {
      const rows = (await query(
        `SELECT id, url_path, title, LEFT(content, 200) AS content_preview
         FROM pages WHERE site_id = $1 AND (content ILIKE $2 OR title ILIKE $2)
         ORDER BY updated_at DESC LIMIT 20`,
        [site.id, likeParam]
      )).rows;

      for (const r of rows) {
        allResults.push({
          site_id: site.id,
          site_name: site.name,
          page_id: r.id,
          url_path: r.url_path,
          title: r.title,
          content_preview: r.content_preview,
        });
      }
    }

    res.json({ results: allResults, total: allResults.length, query: q });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

const bulkFindReplaceSchema = z.object({
  // 200 char max: una regex lunga applicata a TUTTE le pagine pubblicate è un
  // vettore ReDoS (backtracking catastrofico blocca l'event loop di Node).
  find: z.string().min(1).max(200),
  replace: z.string().max(5000).default(""),
  regex: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(false),
});

router.post("/api/agent/sites/:siteId/pages/bulk-find-replace", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { find, replace, regex, dry_run } = bulkFindReplaceSchema.parse(req.body);
    let patternSource;
    let patternFlags;
    try {
      patternSource = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patternFlags = "g";
      new RegExp(patternSource, patternFlags);
    } catch {
      return res.status(400).json({ error: res.locals.t("api.common.invalidRegex") });
    }

    const pages = (await query(
      "SELECT id, url_path, content FROM pages WHERE site_id = $1 AND published = true LIMIT 200",
      [siteId]
    )).rows;
    if (pages.length === 0) return res.json({ pages_affected: 0, total_matches: 0, results: [] });

    const results = [];
    let totalMatches = 0;

    for (const p of pages) {
      const { timedOut: matchTimedOut, result: matchResult } = await runRegexInWorker({ pattern: patternSource, flags: patternFlags, content: p.content, mode: "match" });
      if (matchTimedOut) {
        results.push({ page_id: p.id, url_path: p.url_path, matches: 0, error: res.locals.t("api.common.regexTimeout") });
        continue;
      }
      // match() ritorna null quando non ci sono occorrenze — NON è un errore
      const matches = matchResult === null ? 0 : matchResult.length;
      if (matches === 0) continue;
      totalMatches += matches;
      results.push({ page_id: p.id, url_path: p.url_path, matches });
      if (!dry_run) {
        const { timedOut: replaceTimedOut, result: newContent } = await runRegexInWorker({ pattern: patternSource, flags: patternFlags, content: p.content, replace, mode: "replace" });
        if (replaceTimedOut) {
          results[results.length - 1].error = "Timeout nell'esecuzione della regex (replace)";
          continue;
        }
        // Guardia anti content=NULL (worker fallito → result:null): meglio
        // segnalare l'errore per pagina che azzerare il contenuto.
        if (typeof newContent !== "string") {
          results[results.length - 1].error = "Errore nell'esecuzione della regex (replace)";
          continue;
        }
        await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [newContent, p.id]);
      }
    }

    if (!dry_run && results.length > 0) {
      await auditLog({
        userId: req.user.sub, siteId,
        entityType: "page", entityId: null,
        action: "bulk-find-replace",
        newData: { find, replace, regex, pages_count: results.length, total_matches: totalMatches },
        ipAddress: req.ip,
      });
      exportPublishedPages({ siteId }).catch(() => {});
    }

    res.json({ pages_affected: results.length, total_matches: totalMatches, results, dry_run });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Versioni ───────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages/:pageId/versions", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const versions = (await query(
      `SELECT pv.id, pv.created_at, pv.title, pv.url_path, pv.published,
              u.name AS user_name, u.email AS user_email
       FROM page_versions pv
       LEFT JOIN users u ON u.id = pv.user_id
       WHERE pv.page_id = $1
       ORDER BY pv.created_at DESC`,
      [page.id]
    )).rows;

    res.json({ versions });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/pages/:pageId/versions/:versionId/restore", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const version = (await query(
      "SELECT id FROM page_versions WHERE id = $1 AND page_id = $2",
      [req.params.versionId, page.id]
    )).rows[0];
    if (!version) return res.status(404).json({ error: res.locals.t("api.pages.versionNotFound") });

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [page.id, req.user.sub]
    );

    const result = await query(
      `UPDATE pages SET url_path = v.url_path, title = v.title, content = v.content,
       layout_mode = v.layout_mode, published = v.published, updated_at = NOW()
       FROM page_versions v WHERE pages.id = $1 AND v.id = $2 RETURNING pages.*`,
      [page.id, version.id]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: page.id,
      action: "restore",
      newData: { restored_version_id: version.id, source: "agent" },
      ipAddress: req.ip,
    });

    res.json({ page: result.rows[0] });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    // url_path della versione già occupato da un'altra pagina → 409, non 500
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

// ── Restore last ────────────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/:pageId/restore-last", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const page = (await query("SELECT id, site_id FROM pages WHERE id = $1 AND site_id = $2", [req.params.pageId, siteId])).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const lastVersion = (await query(
      "SELECT id, created_at FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC LIMIT 1",
      [page.id]
    )).rows[0];
    if (!lastVersion) return res.status(400).json({ error: res.locals.t("api.pages.noPreviousVersion") });

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [page.id, req.user.sub]
    );

    await query(
      `UPDATE pages SET url_path = v.url_path, title = v.title, content = v.content,
       layout_mode = v.layout_mode, published = v.published, updated_at = NOW()
       FROM page_versions v WHERE pages.id = $1 AND v.id = $2`,
      [page.id, lastVersion.id]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: page.id,
      action: "restore-last",
      newData: { restored_version_id: lastVersion.id },
      ipAddress: req.ip,
    });

    res.json({ ok: true, restored_version_id: lastVersion.id, restored_at: lastVersion.created_at });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    // url_path della versione già occupato da un'altra pagina → 409, non 500
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

// ── Undo ────────────────────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/:pageId/undo", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const page = (await query("SELECT id, site_id FROM pages WHERE id = $1 AND site_id = $2", [req.params.pageId, siteId])).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const lastVersion = (await query(
      "SELECT id, created_at FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC LIMIT 1",
      [page.id]
    )).rows[0];
    if (!lastVersion) return res.status(400).json({ error: res.locals.t("api.pages.noPreviousVersion") });

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [page.id, req.user.sub]
    );

    await query(
      `UPDATE pages SET url_path = v.url_path, title = v.title, content = v.content,
       layout_mode = v.layout_mode, published = v.published, updated_at = NOW()
       FROM page_versions v WHERE pages.id = $1 AND v.id = $2`,
      [page.id, lastVersion.id]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: page.id,
      action: "undo",
      newData: { restored_version_id: lastVersion.id },
      ipAddress: req.ip,
    });

    res.json({ ok: true, restored_version_id: lastVersion.id, restored_at: lastVersion.created_at });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    // url_path della versione già occupato da un'altra pagina → 409, non 500
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

// ── Pagine — utility ───────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages/:pageId/snippet-usage", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const SNIPPET_RE = /\{\{snippet:([a-zA-Z0-9_-]+)\}\}/g;
    const names = [...new Set([...page.content.matchAll(SNIPPET_RE)].map(m => m[1]))];

    if (names.length === 0) return res.json({ snippets: [], total: 0 });

    const placeholders = names.map((_, i) => `$${i + 2}`).join(",");
    const existing = (await query(
      `SELECT id, name, description FROM snippets WHERE site_id = $1 AND name IN (${placeholders})`,
      [siteId, ...names]
    )).rows;

    const existingNames = new Set(existing.map(s => s.name));

    const snippets = names.map(name => ({
      name,
      tag: `{{snippet:${name}}}`,
      exists: existingNames.has(name),
      ...(existingNames.has(name) ? existing.find(s => s.name === name) : {}),
    }));

    res.json({ snippets, total: snippets.length, broken: snippets.filter(s => !s.exists).length });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/pages/:pageId/rendered", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, url_path, title, content, layout_mode, published FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const rendered = await expandSnippets(siteId, page.content);

    res.json({
      page_id: page.id,
      url_path: page.url_path,
      title: page.title,
      layout_mode: page.layout_mode,
      published: page.published,
      rendered_html: rendered,
      raw_length: page.content.length,
      rendered_length: rendered.length,
    });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/pages/:pageId/diff/:versionId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, content, updated_at FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const version = (await query(
      "SELECT id, content, created_at FROM page_versions WHERE id = $1 AND page_id = $2",
      [req.params.versionId, page.id]
    )).rows[0];
    if (!version) return res.status(404).json({ error: res.locals.t("api.pages.versionNotFound") });

    const currentLines = page.content.split("\n");
    const versionLines = version.content.split("\n");

    const currentCount = {};
    const versionCount = {};
    currentLines.forEach(l => { currentCount[l] = (currentCount[l] || 0) + 1; });
    versionLines.forEach(l => { versionCount[l] = (versionCount[l] || 0) + 1; });

    let added = 0, removed = 0;
    const allLines = new Set([...currentLines, ...versionLines]);
    for (const l of allLines) {
      const c = currentCount[l] || 0;
      const v = versionCount[l] || 0;
      if (c > v) added += c - v;
      if (v > c) removed += v - c;
    }

    res.json({
      page_id: page.id,
      version_id: version.id,
      current_updated_at: page.updated_at,
      version_created_at: version.created_at,
      current_chars: page.content.length,
      version_chars: version.content.length,
      delta_chars: page.content.length - version.content.length,
      current_lines: currentLines.length,
      version_lines: versionLines.length,
      lines_added: added,
      lines_removed: removed,
    });
  } catch (err) { next(err); }
});

// ── Full page report ──────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages/:pageId/full-report", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const page = (await query(
      "SELECT id, url_path, title, layout_mode, published, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const content = page.content || "";
    const b64Matches = [...content.matchAll(/data:(image|font)\/[a-zA-Z0-9+.-]+;base64,([A-Za-z0-9+/=]{20,})/g)];
    // m[2] è la stringa base64 reale; m[1] è solo il tipo ("image"/"font") — 4-5 char
    const totalB64Size = b64Matches.reduce((s, m) => s + Math.floor(m[2].length * 0.75), 0);
    const snippetTags = [...new Set([...content.matchAll(/\{\{snippet:([a-zA-Z0-9_-]+)\}\}/g)].map(m => m[1]))];
    const varTags = [...new Set([...content.matchAll(/\{\{var:([a-zA-Z0-9_-]+)\}\}/g)].map(m => m[1]))];
    const extUrls = [...new Set([...content.matchAll(/https?:\/\/[^"'\s>)]+/g)].map(m => m[0]))];
    const mediaUrls = extUrls.filter(u => /\/media\/\d+\//.test(u));
    const downloadableUrls = extUrls.filter(u => !u.includes("youtube") && !u.includes("vimeo") && /\.(jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|mp3|pdf|js|css|mov)(\?|$)/i.test(u));

    // Check which snippets exist (not broken)
    const snippetResult = snippetTags.length > 0 ? (await query(
      `SELECT name FROM snippets WHERE site_id = $1 AND name IN (${snippetTags.map((_, i) => `$${i + 2}`).join(",")})`,
      [siteId, ...snippetTags]
    )).rows.map(r => r.name) : [];
    const brokenSnippets = snippetTags.filter(n => !snippetResult.includes(n));

    res.json({
      page: {
        id: page.id,
        url_path: page.url_path,
        title: page.title,
        layout_mode: page.layout_mode,
        published: page.published,
      },
      content_size_kb: Math.round(content.length / 1024),
      content_size_formatted: formatKb(Math.round(content.length / 1024)),
      snippets: {
        total: snippetTags.length,
        list: snippetTags,
        broken: brokenSnippets,
      },
      assets: {
        external_urls: extUrls.slice(0, 50),
        external_count: downloadableUrls.length,
        inline_base64: b64Matches.slice(0, 20).map(m => ({
          type: m[0].startsWith("data:image") ? "image" : "font",
          estimated_size_kb: Math.round(Math.floor(m[2].length * 0.75) / 1024),
          estimated_size_formatted: formatKb(Math.round(Math.floor(m[2].length * 0.75) / 1024)),
        })),
        inline_count: b64Matches.length,
        inline_size_kb: Math.round(totalB64Size / 1024),
        inline_size_formatted: formatKb(Math.round(totalB64Size / 1024)),
      },
      variables_used: varTags,
      media_urls: mediaUrls.length,
    });
  } catch (err) { next(err); }
});

// ── Asset report ──────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages/:pageId/asset-report", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const html = page.content;

    const externalUrls = [];
    const urlRe = /(?:src|href|poster|url)\s*=\s*["']?(https?:\/\/[^"'\s>)]+)["']?|url\(\s*["']?(https?:\/\/[^"'\s>)]+)["']?\s*\)/gi;
    let m;
    while ((m = urlRe.exec(html)) !== null) {
      const url = m[1] || m[2];
      const isEmbed = url.includes('youtube') || url.includes('vimeo') ||
                      url.includes('iframe') || url.includes('embed');
      let type = 'other';
      if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(url)) type = 'image';
      else if (/\.(woff2?|ttf|otf|eot)$/i.test(url)) type = 'font';
      else if (/\.css$/i.test(url)) type = 'stylesheet';
      else if (/\.js$/i.test(url)) type = 'script';
      else if (/\.(mp4|mp3|pdf|zip|mov)$/i.test(url)) type = 'media';
      externalUrls.push({
        url, type,
        downloadable: !isEmbed,
        suggestion: isEmbed ? 'embed — non scaricabile' : 'scaricabile con extract-assets',
      });
    }

    // Parsing srcset: estrae URL da attributi srcset (es. <img srcset="photo.jpg 1x, photo@2x.jpg 2x">)
    const srcsetRe = /srcset\s*=\s*["']([^"']+)["']/gi;
    let sm;
    while ((sm = srcsetRe.exec(html)) !== null) {
      const parts = sm[1].split(",");
      for (const part of parts) {
        const url = part.trim().split(/\s+/)[0];
        if (
          url.startsWith("http") &&
          !externalUrls.some(u => u.url === url) &&
          /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(url)
        ) {
          externalUrls.push({
            url, type: 'image',
            downloadable: true,
            suggestion: 'scaricabile con extract-assets (da srcset)',
          });
        }
      }
    }

    const inlineAssets = [];
    const b64Re = /data:(image|font)\/([a-zA-Z0-9+.-]+)(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=]{20,})/g;
    while ((m = b64Re.exec(html)) !== null) {
      const estimatedBytes = Math.floor(m[3].length * 0.75);
      inlineAssets.push({
        type: m[1], format: m[2],
        estimated_size_kb: Math.round(estimatedBytes / 1024),
        suggestion: 'convertibile con inline-to-files',
      });
    }

    const snippetRe = /\{\{snippet:([a-zA-Z0-9_-]+)\}\}/g;
    const snippetTags = [...html.matchAll(snippetRe)].map(x => x[1]);

    res.json({
      page_id: page.id,
      content_size_kb: Math.round(html.length / 1024),
      external_urls: externalUrls,
      inline_assets: inlineAssets,
      snippet_tags: snippetTags,
      summary: {
        external_downloadable: externalUrls.filter(u => u.downloadable).length,
        external_embed: externalUrls.filter(u => !u.downloadable).length,
        inline_assets_total: inlineAssets.length,
        inline_size_kb: inlineAssets.reduce((s, a) => s + a.estimated_size_kb, 0),
      },
    });
  } catch (err) { next(err); }
});

// ── Bulk extract assets ──────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/bulk-extract-assets", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { page_ids } = req.body;
    if (!Array.isArray(page_ids) || page_ids.length === 0) {
      return res.status(400).json({ error: res.locals.t("api.pages.pageIdsRequired") });
    }
    // Cap a 50: senza limite un agente poteva passare migliaia di id → loop
    // di download di rete (ognuno fino a 120s/20MB) → richieste di minuti e
    // saturazione di banda/event loop.
    if (page_ids.length > 50) {
      return res.status(400).json({ error: "Troppe pagine in una chiamata (max 50)." });
    }

    const results = [];
    let totalConverted = 0;
    let totalTooLarge = 0;
    let totalErrors = 0;

    for (const pageId of page_ids) {
      try {
        const page = (await query("SELECT id, content FROM pages WHERE id = $1 AND site_id = $2", [pageId, siteId])).rows[0];
        if (!page) { totalErrors++; continue; }

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

        let html = page.content;
        let pageConverted = 0;
        let pageTooLarge = 0;
        let pageErrors = 0;

        for (const url of candidates) {
          try {
            const result = await fetchUrlToMedia(siteId, url, req.body.force);
            const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            html = html.replace(new RegExp(escapedUrl, 'g'), result.url);
            pageConverted++;
          } catch (err) {
            if (!req.body.force && err.message?.includes("File troppo grande")) {
              pageTooLarge++;
            } else {
              pageErrors++;
            }
          }
        }

        if (pageConverted > 0) {
          await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [html, pageId]);
        }

        results.push({ page_id: pageId, converted: pageConverted, too_large: pageTooLarge, errors: pageErrors });
        totalConverted += pageConverted;
        totalTooLarge += pageTooLarge;
        totalErrors += pageErrors;
      } catch (err) {
        totalErrors++;
        results.push({ page_id: pageId, converted: 0, too_large: 0, errors: 1, error: err.message });
      }
    }

    if (totalConverted > 0) {
      await auditLog({
        userId: req.user.sub, siteId,
        entityType: "page", entityId: null,
        action: "bulk-extract-assets",
        newData: { pages_count: page_ids.length, assets_converted: totalConverted },
        ipAddress: req.ip,
      });
      exportPublishedPages({ siteId }).catch(() => {});
    }

    res.json({ pages_processed: page_ids.length, assets_converted: totalConverted, too_large: totalTooLarge, errors: totalErrors, results });
  } catch (err) { next(err); }
});

// ── Extract assets ────────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/:pageId/extract-assets", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const SKIP = /youtube|vimeo|youtu\.be|embed|maps\.google|fonts\.googleapis|fonts\.gstatic/i;
    const DOWNLOADABLE = /\.(jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|mp3|pdf|js|css|mov)(\?|$)/i;

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

    if (candidates.length === 0) {
      return res.json({ converted: [], message: res.locals.t("api.pages.noDownloadableAssets") });
    }

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [page.id, req.user.sub]
    );

    let html = page.content;
    const converted = [];
    const tooLarge = [];
    const errors = [];
    let reusedCount = 0;
    let dedupedCount = 0;

    for (const url of candidates) {
      try {
        const result = await fetchUrlToMedia(siteId, url, req.body.force);
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        html = html.replace(new RegExp(escapedUrl, 'g'), result.url);
        converted.push({
          original_url: url,
          local_url: result.url,
          filename: result.filename,
          size: result.size,
          reused: result.reused || false,
          deduped: result.deduped || false,
        });
        if (result.reused) reusedCount++;
        if (result.deduped) dedupedCount++;
      } catch (err) {
        if (!req.body.force && err.message && err.message.includes("File troppo grande")) {
          tooLarge.push({ url, error: err.message });
        } else {
          errors.push({ url, error: err.message });
        }
      }
    }

    const pagesUpdated = { current: 0, cross_page: 0, total: 0, affected: [] };

    if (converted.length > 0) {
      await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [html, page.id]);
      pagesUpdated.current = 1;

      for (const item of converted) {
        const otherPages = (await query(
          `SELECT id, url_path FROM pages WHERE site_id = $1 AND position($2 in content) > 0 AND id != $3`,
          [siteId, item.original_url, page.id]
        )).rows;
        if (otherPages.length > 0) {
          await query(
            `UPDATE pages SET content = REPLACE(content, $1, $2), updated_at = NOW()
             WHERE site_id = $3 AND position($1 in content) > 0 AND id != $4`,
            [item.original_url, item.local_url, siteId, page.id]
          );
          pagesUpdated.cross_page += otherPages.length;
          pagesUpdated.affected.push(...otherPages);
        }
      }
      pagesUpdated.total = pagesUpdated.current + pagesUpdated.cross_page;

      await auditLog({
        userId: req.user.sub, siteId,
        entityType: "page", entityId: page.id,
        action: "update",
        oldData: { source: "agent-extract-assets", assets_count: converted.length },
        newData: {
          converted: converted.map(c => c.original_url),
          reused: reusedCount,
          deduped: dedupedCount,
          cross_page_updated: pagesUpdated.cross_page,
          affected_pages: pagesUpdated.affected.map(p => p.url_path),
        },
        ipAddress: req.ip,
      });
    }

    const msgParts = [];
    if (converted.length) {
      let m = `Scaricati ${converted.length} asset`;
      if (reusedCount) m += ` (${reusedCount} già presenti`;
      if (dedupedCount) m += `, ${dedupedCount} deduplicati per hash`;
      if (reusedCount || dedupedCount) m += `)`;
      msgParts.push(m);
    }
    if (pagesUpdated.cross_page) msgParts.push(`Aggiornate ${pagesUpdated.total} pagine (${pagesUpdated.cross_page} cross-page)`);
    if (tooLarge.length) msgParts.push(`${tooLarge.length} troppo grandi >20MB (chiedi conferma)`);
    if (errors.length) msgParts.push(`${errors.length} errori`);

    res.json({
      converted,
      tooLarge,
      errors,
      pages_updated: pagesUpdated,
      message: msgParts.join(". ") + ".",
    });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) { next(err); }
});

// ── Bulk inline to files ──────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/bulk-inline-to-files", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { page_ids } = req.body;
    if (!Array.isArray(page_ids) || page_ids.length === 0) {
      return res.status(400).json({ error: res.locals.t("api.pages.pageIdsRequired") });
    }
    // Cap a 50: senza limite un agente poteva passare migliaia di id → loop
    // di download di rete (ognuno fino a 120s/20MB) → richieste di minuti e
    // saturazione di banda/event loop.
    if (page_ids.length > 50) {
      return res.status(400).json({ error: "Troppe pagine in una chiamata (max 50)." });
    }

    const b64Re = /data:(image|font)\/([a-zA-Z0-9+.-]+)(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=]{20,})/g;
    const extMap = { jpeg:'jpg', jpg:'jpg', png:'png', gif:'gif', webp:'webp', svg:'svg', woff:'woff', woff2:'woff2', ttf:'ttf', otf:'otf', eot:'eot' };

    const results = [];
    let totalConverted = 0;
    let totalPagesProcessed = 0;

    for (const pageId of page_ids) {
      try {
        const page = (await query("SELECT id, content FROM pages WHERE id = $1 AND site_id = $2", [pageId, siteId])).rows[0];
        if (!page) continue;

        const matches = [...page.content.matchAll(b64Re)];
        if (matches.length === 0) continue;

        await query(
          `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
           SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
          [page.id, req.user.sub]
        );

        let html = page.content;
        let pageConverted = 0;
        let totalBytes = 0;

        for (const m of matches) {
          const [fullMatch, category, format, b64] = m;
          if (!html.includes(fullMatch)) continue;
          const normalizedFormat = format.toLowerCase().split('+')[0];
          const ext = extMap[normalizedFormat] || normalizedFormat;
          const buffer = Buffer.from(b64, 'base64');
          // Cap per blob e totale per pagina: stessa soglia della singola
          // inline-to-files e di media-utils (8MB/64MB).
          if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) continue;
          totalBytes += buffer.length;
          if (totalBytes > 64 * 1024 * 1024) break;
          try {
            const result = saveBufferToMedia(siteId, buffer, ext);
            html = html.split(fullMatch).join(result.url);
            pageConverted++;
          } catch (_) {}
        }

        if (pageConverted > 0) {
          await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [html, page.id]);
        }

        results.push({ page_id: pageId, converted: pageConverted });
        totalConverted += pageConverted;
        totalPagesProcessed++;
      } catch (err) {
        results.push({ page_id: pageId, converted: 0, error: err.message });
      }
    }

    if (totalConverted > 0) {
      exportPublishedPages({ siteId }).catch(() => {});
    }

    res.json({ pages_processed: totalPagesProcessed, total_converted: totalConverted, results });
  } catch (err) { next(err); }
});

// ── Inline to files ────────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/:pageId/inline-to-files", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const b64Re = /data:(image|font)\/([a-zA-Z0-9+.-]+)(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=]{20,})/g;
    const matches = [...page.content.matchAll(b64Re)];

    if (matches.length === 0) {
      return res.json({ converted: 0, files: [], message: res.locals.t("api.pages.noBase64Assets") });
    }

    const extMap = {
      jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp',
      svg: 'svg',
      woff: 'woff', woff2: 'woff2', ttf: 'ttf', otf: 'otf', eot: 'eot',
    };

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       SELECT id, $2, url_path, title, content, layout_mode, published FROM pages WHERE id = $1`,
      [page.id, req.user.sub]
    );

    let html = page.content;
    const files = [];
    let reusedCount = 0;
    // Stessa soglia di media-utils.js (extractAndReplaceBase64): senza cap un
    // agente può scrivere GB di base64 su disco con una singola richiesta.
    const MAX_B64_BLOB_BYTES = 8 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
    let totalBytes = 0;

    for (const m of matches) {
      const [fullMatch, category, format, b64] = m;
      if (!html.includes(fullMatch)) continue;

      const normalizedFormat = format.toLowerCase().split('+')[0];
      const ext = extMap[normalizedFormat] || normalizedFormat;
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_B64_BLOB_BYTES) continue;
      totalBytes += buffer.length;
      if (totalBytes > MAX_TOTAL_BYTES) break;

      try {
        const result = saveBufferToMedia(siteId, buffer, ext);
        html = html.split(fullMatch).join(result.url);
        const fSizeKb = Math.round(buffer.length / 1024);
        files.push({
          type: category, format,
          filename: result.filename,
          local_url: result.url,
          size_kb: fSizeKb,
          size_formatted: formatKb(fSizeKb),
          reused: result.reused,
        });
        if (result.reused) reusedCount++;
      } catch (_) {}
    }

    if (files.length > 0) {
      await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [html, page.id]);
      await auditLog({
        userId: req.user.sub, siteId,
        entityType: "page", entityId: page.id,
        action: "update",
        oldData: { source: "agent-inline-to-files", assets_count: files.length },
        newData: { files: files.map(f => f.filename), reused_count: reusedCount },
        ipAddress: req.ip,
      });
    }

    const msg = reusedCount > 0
      ? `Convertiti ${files.length} asset inline in file locali (${reusedCount} già presenti, riusati).`
      : `Convertiti ${files.length} asset inline in file locali.`;

    if (req.query.minimal === "true") {
      res.json({ converted: files.length, message: msg });
    } else {
      const nSizeKb = Math.round(html.length / 1024);
      res.json({
        converted: files.length,
        files,
        reused_count: reusedCount,
        new_size_kb: nSizeKb,
        new_size_formatted: formatKb(nSizeKb),
        message: msg,
      });
    }
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) { next(err); }
});

// ── Validate ──────────────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/pages/:pageId/validate", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const html = page.content;
    const issues = [];

    const SNIPPET_RE = /\{\{snippet:([a-zA-Z0-9_-]+)\}\}/g;
    const snippetNames = [...new Set([...html.matchAll(SNIPPET_RE)].map(m => m[1]))];
    if (snippetNames.length > 0) {
      const placeholders = snippetNames.map((_, i) => `$${i + 2}`).join(',');
      const existing = (await query(
        `SELECT name FROM snippets WHERE site_id = $1 AND name IN (${placeholders})`,
        [siteId, ...snippetNames]
      )).rows.map(r => r.name);
      const broken = snippetNames.filter(n => !existing.includes(n));
      for (const name of broken) {
        issues.push({ type: 'broken_snippet', severity: 'error', detail: `{{snippet:${name}}} non esiste` });
      }
    }

    const b64Re = /data:(image|font)\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]{100,}/g;
    const b64Matches = [...html.matchAll(b64Re)];
    if (b64Matches.length > 0) {
      issues.push({
        type: 'inline_base64', severity: 'warning',
        detail: `${b64Matches.length} asset base64 inline trovati. Usa inline-to-files per convertirli.`,
      });
    }

    const extRe = /(?:src|href)\s*=\s*["'](https?:\/\/[^"']+\.(jpg|jpeg|png|gif|webp|woff2?|ttf|otf)(\?[^"']*)?)["']/gi;
    const extMatches = [...html.matchAll(extRe)];
    if (extMatches.length > 0) {
      issues.push({
        type: 'external_assets', severity: 'warning',
        detail: `${extMatches.length} URL esterni scaricabili trovati. Usa extract-assets per localizzarli.`,
      });
    }

    const openTags = (html.match(/<(div|section|article|main|header|footer|nav|ul|ol|table|tr|td|th)\b/gi) || []).length;
    const closeTags = (html.match(/<\/(div|section|article|main|header|footer|nav|ul|ol|table|tr|td|th)>/gi) || []).length;
    const tagDelta = openTags - closeTags;
    if (Math.abs(tagDelta) > 2) {
      issues.push({
        type: 'unbalanced_tags', severity: 'warning',
        detail: `Possibile squilibrio HTML: ${openTags} aperture, ${closeTags} chiusure (delta ${tagDelta}).`,
      });
    }

    res.json({
      ok: issues.filter(i => i.severity === 'error').length === 0,
      issues,
      content_size_kb: Math.round(html.length / 1024),
    });
  } catch (err) { next(err); }
});

// ── Snippet ────────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/snippets", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }
    const snippets = (await query(
      "SELECT id, name, description, content, created_at, updated_at FROM snippets WHERE site_id = $1 ORDER BY name",
      [siteId]
    )).rows;
    res.json({ snippets });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/snippets/:snippetId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const result = await query(
      "SELECT * FROM snippets WHERE id = $1 AND site_id = $2",
      [req.params.snippetId, siteId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: res.locals.t("api.snippets.notFound") });

    res.json({ snippet: result.rows[0] });
  } catch (err) { next(err); }
});

const agentSnippetSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Solo lettere, numeri, underscore e trattini"),
  content: z.string().optional().default(""),
  description: z.string().optional().default(""),
});

router.post("/api/agent/sites/:siteId/snippets", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }
    const data = agentSnippetSchema.parse(req.body);
    const result = await query(
      "INSERT INTO snippets (site_id, name, content, description) VALUES ($1, $2, $3, $4) RETURNING *",
      [siteId, data.name, data.content, data.description]
    );
    res.status(201).json({ snippet: result.rows[0] });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.snippets.nameExists") });
    next(err);
  }
});

router.put("/api/agent/sites/:siteId/snippets/:snippetId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }
    const existing = (await query(
      "SELECT id, name FROM snippets WHERE id = $1 AND site_id = $2",
      [req.params.snippetId, siteId]
    )).rows[0];
    if (!existing) return res.status(404).json({ error: res.locals.t("api.snippets.notFound") });

    // Conta le pagine impattate
    const tag = `{{snippet:${existing.name}}}`;
    const usedInPages = (await query(
      "SELECT id, url_path, title FROM pages WHERE site_id = $1 AND content LIKE $2",
      [siteId, `%${tag}%`]
    )).rows;

    const data = agentSnippetSchema.parse(req.body);
    const result = await query(
      "UPDATE snippets SET name = $1, content = $2, description = $3, updated_at = NOW() WHERE id = $4 RETURNING *",
      [data.name, data.content, data.description, req.params.snippetId]
    );

    // Rename: se il nome cambia, il tag {{snippet:vecchio}} nelle pagine
    // NON segue da solo — prima le pagine renderizzavano vuoto e l'export
    // pubblicava contenuto rotto, con un warning che diceva il contrario
    // (\"già attiva su tutte\" era falso per le pagine col tag vecchio).
    let renamedPages = 0;
    if (data.name !== existing.name) {
      const oldTag = `{{snippet:${existing.name}}}`;
      const newTag = `{{snippet:${data.name}}}`;
      const rename = await query(
        "UPDATE pages SET content = REPLACE(content, $1, $2), updated_at = NOW() WHERE site_id = $3 AND content LIKE $4",
        [oldTag, newTag, siteId, `%${oldTag}%`]
      );
      renamedPages = rename.rowCount;
    }

    res.json({
      snippet: result.rows[0],
      impact: {
        pages_count: usedInPages.length,
        renamed_pages: renamedPages,
        pages: usedInPages.map(p => ({ id: p.id, url_path: p.url_path, title: p.title })),
        warning: usedInPages.length > 0
          ? (renamedPages > 0
              ? `Snippet rinominato: tag aggiornati automaticamente in ${renamedPages} pagina/e.`
              : `Questo snippet è usato in ${usedInPages.length} pagina/e. La modifica è già attiva su tutte.`)
          : null,
      },
    });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.snippets.nameExists") });
    next(err);
  }
});

router.post("/api/agent/sites/:siteId/snippets/:snippetId/find-replace", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const snippet = (await query(
      "SELECT id, name, content FROM snippets WHERE id = $1 AND site_id = $2",
      [req.params.snippetId, siteId]
    )).rows[0];
    if (!snippet) return res.status(404).json({ error: res.locals.t("api.snippets.notFound") });

    const { find, replace, regex, flags } = findReplaceSchema.parse(req.body);

    if (regex && find.length > 100) {
      return res.status(400).json({ error: res.locals.t("api.common.regexTooLong") });
    }

    let patternSource;
    let patternFlags;
    try {
      patternSource = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patternFlags = regex ? flags : "g";
      new RegExp(patternSource, patternFlags);
    } catch {
      return res.status(400).json({ error: res.locals.t("api.common.invalidRegexExpr") });
    }

    const { timedOut: matchTimedOut, result: matchResult } = await runRegexInWorker({ pattern: patternSource, flags: patternFlags, content: snippet.content, mode: "match" });
    if (matchTimedOut) {
      return res.status(400).json({ error: res.locals.t("api.common.regexTimeout") });
    }
    // match() ritorna null quando non ci sono occorrenze (NON è un timeout)
    if (matchResult === null) return res.json({ matches: 0, message: res.locals.t("api.snippets.noMatchFound") });
    const matches = matchResult.length;

    const { timedOut: replaceTimedOut, result: newContent } = await runRegexInWorker({ pattern: patternSource, flags: patternFlags, content: snippet.content, replace, mode: "replace" });
    if (replaceTimedOut) {
      return res.status(400).json({ error: res.locals.t("api.common.regexTimeout") });
    }
    await query(
      "UPDATE snippets SET content = $1, updated_at = NOW() WHERE id = $2",
      [newContent, snippet.id]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "snippet", entityId: snippet.id,
      action: "update",
      oldData: { name: snippet.name, content_length: snippet.content.length, source: "agent-find-replace" },
      newData: { find, replace, matches },
      ipAddress: req.ip,
    });

    res.json({ matches, message: res.locals.t("api.snippets.replacedOccurrences", { n: matches, name: snippet.name }) });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Snippet usage ──────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/snippets/:snippetId/usage", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const snippet = (await query(
      "SELECT id, name FROM snippets WHERE id = $1 AND site_id = $2",
      [req.params.snippetId, siteId]
    )).rows[0];
    if (!snippet) return res.status(404).json({ error: res.locals.t("api.snippets.notFound") });

    const tag = `{{snippet:${snippet.name}}}`;
    const pages = (await query(
      "SELECT id, url_path, title FROM pages WHERE site_id = $1 AND content LIKE $2 ORDER BY url_path",
      [siteId, `%${tag}%`]
    )).rows;

    res.json({
      snippet_id: snippet.id,
      snippet_name: snippet.name,
      total_pages: pages.length,
      pages,
    });
  } catch (err) { next(err); }
});

// ── Media ──────────────────────────────────────────────────────────────────

const agentUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      // parseInt permissivo accetta "1abc" → 1, ma il param grezzo creerebbe
      // MEDIA_ROOT/1abc (dir orfana che nessuno serve). Usa sempre l'intero.
      const siteId = parseInt(req.params.siteId, 10);
      if (!Number.isInteger(siteId) || siteId < 1) return cb(new Error("ID sito non valido"));
      cb(null, ensureSiteDir(siteId));
    },
    filename(_req, file, cb) {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, Date.now() + "_" + safe);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ALLOWED = /\.(jpg|jpeg|png|gif|webp|svg|mp4|mp3|pdf|zip|woff|woff2|ttf|otf|eot|ico)$/i;
    if (!ALLOWED.test(file.originalname)) return cb(new Error("Tipo file non consentito"));
    cb(null, true);
  },
});

router.get("/api/agent/sites/:siteId/media", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    const dir = getSiteDir(siteId);
    let files = [];
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, size: stat.size, size_formatted: formatBytes(stat.size), mtime: stat.mtime, url: `/media/${siteId}/${name}` };
      }).sort((a, b) => b.mtime - a.mtime);
    }
    res.json({ files });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/media/unused", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const dir = getSiteDir(siteId);
    if (!fs.existsSync(dir)) return res.json({ unused_count: 0, unused_size_mb: 0, files: [] });

    const mediaPattern = new RegExp(`/media/${siteId}/[^"'\s>)]+`, "g");
    const pages = (await query("SELECT content FROM pages WHERE site_id = $1", [siteId])).rows;
    const usedUrls = new Set();
    for (const p of pages) {
      if (!p.content) continue;
      const urls = [...p.content.matchAll(mediaPattern)].map(m => path.basename(m[0]));
      for (const u of urls) usedUrls.add(u);
    }

    const allFiles = fs.readdirSync(dir);
    const unused = allFiles
      .filter(name => !name.endsWith(".tmp.mp4") && !name.endsWith(".alt.txt"))
      .filter(name => !usedUrls.has(name))
      .map(name => {
        const stat = fs.statSync(path.join(dir, name));
        const uSizeKb = Math.round(stat.size / 1024);
        return { filename: name, size_kb: uSizeKb, size_formatted: formatKb(uSizeKb), last_modified: stat.mtime };
      })
      .sort((a, b) => b.size_kb - a.size_kb);

    const totalSizeKb = unused.reduce((s, f) => s + f.size_kb, 0);

    res.json({
      unused_count: unused.length,
      unused_size_mb: Math.round(totalSizeKb / 1024),
      unused_size_formatted: formatKb(totalSizeKb),
      files: unused,
    });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/media/upload", requireAuth, requireAgent, (req, res, next) => {
  const siteId = parseInt(req.params.siteId, 10);
  canAccessSite(req.user, siteId).then(ok => {
    if (!ok) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    agentUpload.single("file")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: res.locals.t("api.media.noFileReceived") });

      const declaredExt = path.extname(req.file.filename).slice(1);
      const uploadedBuffer = fs.readFileSync(req.file.path);
      if (!(await verifyMagicBytes(uploadedBuffer, declaredExt))) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: res.locals.t("api.media.contentMismatch") });
      }

      sanitizeSvgFileIfNeeded(req.file.path);
      const finalSize = fs.statSync(req.file.path).size;
      compressVideo(req.file.path).catch(() => {});
      res.status(201).json({
        file: {
          filename: req.file.filename,
          url: `/media/${siteId}/${req.file.filename}`,
          size: finalSize,
          size_formatted: formatBytes(finalSize),
        },
      });
    });
  }).catch(next);
});

router.post("/api/agent/sites/:siteId/media/fetch-url", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    const { url, force } = req.body;
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: res.locals.t("api.common.invalidUrl") }); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: res.locals.t("api.media.onlyHttpSchemesAllowed") });
    }
    const hostname = parsedUrl.hostname;
    const privateIpRegex = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|127\.|0\.|::1$|localhost)/;
    if (privateIpRegex.test(hostname)) {
      return res.status(400).json({ error: res.locals.t("api.media.internalAddressNotAllowed") });
    }
    const result = await fetchUrlToMedia(siteId, url, force);
    res.status(201).json({ file: result });
  } catch (err) {
    res.status(400).json({ error: res.locals.t("api.media.importFailed") + err.message });
  }
});

router.delete("/api/agent/sites/:siteId/media/:filename", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    const { filename } = req.params;
    if (filename.includes("..") || filename.includes("/")) return res.status(400).json({ error: res.locals.t("api.media.invalidFilename") });
    const filePath = path.join(getSiteDir(siteId), filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ deleted: filename });
  } catch (err) { next(err); }
});

// ── Media cleanup ──────────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/media/cleanup", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const dir = getSiteDir(siteId);
    if (!fs.existsSync(dir)) return res.json({ deleted: 0, deleted_files: [], freed_bytes: 0, errors: [] });

    let filesToDelete = [];
    if (req.body.all_unused === true) {
      const mediaPattern = new RegExp(`/media/${siteId}/[^"'\s>)]+`, "g");
      const pages = (await query("SELECT content FROM pages WHERE site_id = $1", [siteId])).rows;
      const usedUrls = new Set();
      for (const p of pages) {
        if (!p.content) continue;
        const urls = [...p.content.matchAll(mediaPattern)].map(m => path.basename(m[0]));
        for (const u of urls) usedUrls.add(u);
      }
      filesToDelete = fs.readdirSync(dir).filter(name =>
        !name.endsWith(".tmp.mp4") && !name.endsWith(".alt.txt") && !usedUrls.has(name)
      );
    } else if (Array.isArray(req.body.filenames)) {
      filesToDelete = req.body.filenames.filter(f => !f.includes("..") && !f.includes("/"));
    } else {
      return res.status(400).json({ error: res.locals.t("api.media.specifyFilenamesOrAllUnused") });
    }

    const deleted = [];
    const errors = [];
    let freedBytes = 0;

    for (const name of filesToDelete) {
      const fp = path.join(dir, name);
      try {
        if (fs.existsSync(fp)) {
          freedBytes += fs.statSync(fp).size;
          fs.unlinkSync(fp);
          deleted.push(name);
        }
      } catch (e) {
        errors.push({ filename: name, error: e.message });
      }
    }

    res.json({ deleted: deleted.length, deleted_files: deleted, freed_bytes: freedBytes, freed_formatted: formatBytes(freedBytes), errors });
  } catch (err) { next(err); }
});

// ── Settings ───────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/settings", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const rows = (await query(
      "SELECT key, value FROM settings WHERE site_id = $1 ORDER BY key",
      [siteId]
    )).rows;

    // Maschera i segreti: il token CAPI non deve mai uscire in chiaro dalla GET
    // settings generica (stesso pattern di /tracking e della password SMTP).
    const masked = rows.map(r => {
      if (r.key === "tracking_meta_capi_token") {
        return { ...r, value: r.value ? "••••••••" : "" };
      }
      return r;
    });

    const site = (await query(
      "SELECT homepage_path FROM sites WHERE id = $1",
      [siteId]
    )).rows[0];

    res.json({ settings: masked, homepage_path: site?.homepage_path || null });
  } catch (err) { next(err); }
});

const agentSettingSchema = z.object({
  value: z.string(),
});

router.put("/api/agent/sites/:siteId/settings/:key", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    // Solo admin/superadmin: la scrittura delle settings di sito è operazione
    // privilegiata (un `collaboratore` con token non deve poterla fare via
    // superficie agent, aggirando la matrice permessi).
    if (req.user.role !== "superadmin" && req.user.role !== "admin") {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }

    const { key } = req.params;
    const { value } = agentSettingSchema.parse(req.body);

    if (key === "homepage_path") {
      await query("UPDATE sites SET homepage_path = $1, updated_at = NOW() WHERE id = $2", [value, siteId]);
      exportPublishedPages({ siteId }).catch(() => {});
      return res.json({ key, value });
    }

    await query(
      `INSERT INTO settings (site_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (site_id, key) DO UPDATE SET value = $3`,
      [siteId, key, value]
    );
    res.json({ key, value });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Audit log ──────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/audit-log", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const limit = Math.min(parseIntParam(req.query.limit, 50), 200);
    const offset = parseIntParam(req.query.offset, 0);
    const entityType = req.query.entity_type || null;

    const params = [siteId, limit, offset];
    const typeFilter = entityType ? `AND entity_type = $${params.push(entityType)}` : "";

    const rows = (await query(
      `SELECT al.id, al.entity_type, al.entity_id, al.action,
              al.old_data, al.new_data, al.ip_address, al.created_at,
              u.name AS user_name, u.email AS user_email
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.site_id = $1 ${typeFilter}
       ORDER BY al.created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    )).rows;

    res.json({ entries: rows, limit, offset });
  } catch (err) { next(err); }
});

// ── Stats ──────────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/stats", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const result = await query(
      `SELECT
         (SELECT COUNT(*) FROM pages WHERE site_id = $1) AS pages_total,
         (SELECT COUNT(*) FROM pages WHERE site_id = $1 AND published = true) AS pages_published,
         (SELECT COUNT(*) FROM pages WHERE site_id = $1 AND published = false) AS pages_draft,
         (SELECT COUNT(*) FROM snippets WHERE site_id = $1) AS snippets_total,
         (SELECT MAX(updated_at) FROM pages WHERE site_id = $1) AS last_page_updated,
         (SELECT MAX(updated_at) FROM snippets WHERE site_id = $1) AS last_snippet_updated`,
      [siteId]
    );

    const stats = result.rows[0];

    const dir = getSiteDir(siteId);
    let media_files = 0;
    if (fs.existsSync(dir)) {
      media_files = fs.readdirSync(dir).length;
    }

    res.json({
      pages_total: parseInt(stats.pages_total),
      pages_published: parseInt(stats.pages_published),
      pages_draft: parseInt(stats.pages_draft),
      snippets_total: parseInt(stats.snippets_total),
      media_files,
      last_updated: [stats.last_page_updated, stats.last_snippet_updated]
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    });
  } catch (err) { next(err); }
});

// ── Moduli opzionali ───────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/modules", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const enabled = new Set(await listEnabledModules(siteId));
    res.json({
      modules: MODULE_KEYS.map(key => ({ key, ...MODULES[key], enabled: enabled.has(key) })),
    });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/modules/:key", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!MODULE_KEYS.includes(req.params.key)) return res.status(400).json({ error: res.locals.t("api.modules.unknownKey") });

    const enabled = req.body.enabled === true;
    await query(
      `INSERT INTO site_modules (site_id, module_key, enabled, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (site_id, module_key) DO UPDATE SET enabled = $3, updated_at = NOW()`,
      [siteId, req.params.key, enabled]
    );
    res.json({ key: req.params.key, enabled });
  } catch (err) { next(err); }
});

// ── Pipeline vendite (richiede modulo sales_pipeline attivo) ───────────────

router.get("/api/agent/sites/:siteId/pipeline", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (req.user.role !== "superadmin" && !await isModuleEnabled(siteId, "sales_pipeline")) {
      return res.status(403).json({ error: res.locals.t("api.modules.notEnabled") });
    }

    const board = await getPipelineBoard(siteId);
    const stages = [{ key: "", label: "Da assegnare" }, ...PIPELINE_STAGES].map(s => ({
      ...s,
      contacts: board[s.key] || [],
      total_value: (board[s.key] || []).reduce((sum, c) => sum + (parseFloat(c.value_estimate) || 0), 0),
    }));
    res.json({ stages });
  } catch (err) { next(err); }
});

// ── Chiamate (richiede modulo call_scheduling attivo) ──────────────────────

async function requireCallsModule(req, res, siteId) {
  if (req.user.role === "superadmin") return true;
  if (await isModuleEnabled(siteId, "call_scheduling")) return true;
  res.status(403).json({ error: res.locals.t("api.modules.notEnabled") });
  return false;
}

router.get("/api/agent/sites/:siteId/calls", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    const calendarId = req.query.calendar_id ? parseInt(req.query.calendar_id, 10) : null;
    const calls = req.query.email
      ? await listCallsForContact(siteId, req.query.email)
      : await listUpcomingCalls(siteId, { calendarId });
    res.json({ calls });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/calls", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    const start = new Date(req.body.scheduled_at);
    if (!req.body.email || isNaN(start.getTime())) {
      return res.status(400).json({ error: res.locals.t("api.calls.invalidData") });
    }
    const result = await scheduleCallManually(siteId, {
      email: req.body.email, name: req.body.name, start,
      durationMinutes: req.body.duration_minutes || 30,
      createdBy: req.user.sub,
      calendarId: req.body.calendar_id ? parseInt(req.body.calendar_id, 10) : null,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/calls/availability", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    const calendarId = req.query.calendar_id ? parseInt(req.query.calendar_id, 10) : null;
    res.json({ rules: await getAvailabilityRules(siteId, calendarId) });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/calls/availability", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;
    if (!Array.isArray(req.body.rules)) return res.status(400).json({ error: res.locals.t("api.calls.invalidData") });

    const calendarId = req.body.calendar_id ? parseInt(req.body.calendar_id, 10) : null;
    await setAvailabilityRules(siteId, req.body.rules, calendarId);
    res.json({ rules: await getAvailabilityRules(siteId, calendarId) });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/calls/slots", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    const days = Math.min(parseIntParam(req.query.days, 14), 60);
    const calendarId = req.query.calendar_id ? parseInt(req.query.calendar_id, 10) : null;
    res.json({ slots: await computeAvailableSlots(siteId, { days, calendarId }) });
  } catch (err) { next(err); }
});

// Prenota per conto di qualcuno (es. un flow n8n che riceve una risposta su
// WhatsApp/email e prenota direttamente) — stessa logica della prenotazione
// pubblica (ri-verifica lo slot, invia conferma), ma autenticata.
router.post("/api/agent/sites/:siteId/calls/book", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    const start = new Date(req.body.start);
    if (!req.body.email || isNaN(start.getTime())) {
      return res.status(400).json({ error: res.locals.t("api.calls.invalidData") });
    }
    const result = await bookCall(siteId, {
      email: req.body.email, name: req.body.name, start,
      durationMinutes: req.body.duration_minutes || 30,
      notify: req.body.notify !== false,
      calendarId: req.body.calendar_id ? parseInt(req.body.calendar_id, 10) : null,
    });
    if (!result.ok) return res.status(409).json({ error: res.locals.t("api.calls.slotTaken") });
    res.json(result);
  } catch (err) { next(err); }
});

// Nota ordine route: definita DOPO le sotto-route /calls/availability,
// /calls/slots e /calls/book — Express matcha in ordine di registrazione,
// quindi :callId qui sotto inghiottirebbe quei path se fosse prima.
router.put("/api/agent/sites/:siteId/calls/:callId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    await setCallOutcome(siteId, req.params.callId, { status: req.body.status, outcomeNotes: req.body.outcome_notes });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === "Stato chiamata non valido") return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ── Calendari (multi-agenda, richiede modulo call_scheduling attivo) ───────
// Ogni calendario è un'\"agenda\" prenotabile (es. \"Consulenza\", \"Demo\",
// \"Assistenza\") con la propria disponibilità settimanale e le proprie
// chiamate. Si integra nelle pagine con {{calendar:slug}} (espanso dal
// page-renderer come {{form:slug}}). Un calendario disattivato non viene
// più espanso nelle pagine né risolto da /book/:siteId/:slug.

router.get("/api/agent/sites/:siteId/calendars", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    res.json({ calendars: await listCalendars(siteId) });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/calendars", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    const id = await createCalendar(siteId, {
      name: req.body.name, slug: req.body.slug,
      description: req.body.description,
      userId: req.body.user_id ? parseInt(req.body.user_id, 10) : null,
      enabled: req.body.enabled !== false,
      tyPage: req.body.ty_page,
    });
    res.json({ calendar: await getCalendar(siteId, id) });
  } catch (err) {
    if (err.message.startsWith("Nome e slug") || err.message.startsWith("Esiste già")) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.put("/api/agent/sites/:siteId/calendars/:calendarId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    const calendarId = parseInt(req.params.calendarId, 10);
    // Merge con lo stato attuale: i campi omessi restano invariati (stesso
    // pattern di tracking_set). updateCalendar sovrascrive TUTTO, quindi
    // senza merge un PUT con {name} azzererebbe description/user_id/ty_page.
    const current = await getCalendar(siteId, calendarId);
    if (!current) return res.status(404).json({ error: res.locals.t("api.common.notFound") });
    await updateCalendar(siteId, calendarId, {
      name: req.body.name ?? current.name,
      slug: req.body.slug ?? current.slug,
      description: req.body.description ?? current.description,
      userId: req.body.user_id !== undefined ? parseInt(req.body.user_id, 10) : (current.user_id ?? null),
      enabled: req.body.enabled !== undefined ? !!req.body.enabled : current.enabled,
      tyPage: req.body.ty_page !== undefined ? req.body.ty_page : (current.ty_page ?? ""),
    });
    res.json({ calendar: await getCalendar(siteId, calendarId) });
  } catch (err) {
    if (err.message.startsWith("Nome e slug") || err.message.startsWith("Esiste già")) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.delete("/api/agent/sites/:siteId/calendars/:calendarId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    if (!await requireCallsModule(req, res, siteId)) return;

    await deleteCalendar(siteId, parseInt(req.params.calendarId, 10));
    res.json({ deleted: parseInt(req.params.calendarId) });
  } catch (err) { next(err); }
});

// ── Tracking & Analytics ────────────────────────────────────────────────
// Comoda su un'unica chiamata rispetto a GET/PUT .../settings generici (che
// restano comunque validi, stesse chiavi tracking_* sotto — vedi
// services/tracking.js). Token CAPI mai in chiaro nella risposta GET, stesso
// trattamento della password SMTP della newsletter.

router.get("/api/agent/sites/:siteId/tracking", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    res.json(await getSiteTrackingConfigMasked(siteId));
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/tracking", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const fields = {};
    for (const f of [
      "ga4Id", "gtmId", "metaPixelId", "metaCapiToken", "metaCapiTestCode", "clarityId", "searchConsoleVerification",
      "consentBannerText", "consentAcceptLabel", "consentRejectLabel", "consentPrivacyUrl",
      "consentProvider", "consentLibUrl", "consentLibCssUrl", "consentScriptUrl",
      "leadEventName", "leadPages",
    ]) {
      if (f in req.body) fields[f] = req.body[f];
    }
    // Un agente che fa GET (token mascherato) -> modifica un campo -> PUT
    // dell'intero oggetto non deve corrompere il token reale con la
    // stringa mascherata: se arriva invariata, non è un valore da salvare.
    if (fields.metaCapiToken === "••••••••") delete fields.metaCapiToken;
    await setSiteTrackingConfig(siteId, fields);
    res.json(await getSiteTrackingConfigMasked(siteId));
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/pages/:pageId/tracking", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const pageId = parseInt(req.params.pageId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    // Verifica che la pagina appartenga al sito
    const page = (await query("SELECT id FROM pages WHERE id = $1 AND site_id = $2", [pageId, siteId])).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const override = await getPageTrackingOverride(pageId);
    res.json({ pixelEnabled: override.pixel_enabled, trackPageview: override.track_pageview, trackLead: override.track_lead });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/pages/:pageId/tracking", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const pageId = parseInt(req.params.pageId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    // Verifica che la pagina appartenga al sito
    const page = (await query("SELECT id FROM pages WHERE id = $1 AND site_id = $2", [pageId, siteId])).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const fields = {};
    for (const f of ["pixelEnabled", "trackPageview", "trackLead"]) {
      if (f in req.body) fields[f] = req.body[f];
    }
    await setPageTrackingOverride(pageId, fields);
    const override = await getPageTrackingOverride(pageId);
    res.json({ pixelEnabled: override.pixel_enabled, trackPageview: override.track_pageview, trackLead: override.track_lead });
  } catch (err) { next(err); }
});

// ── SEO ────────────────────────────────────────────────────────────────────
// Default a livello di sito (immagine OG di default, handle Twitter, regole
// extra per robots.txt) — usati come fallback dalle pagine "wrapped" che non
// impostano un proprio og_image. Comoda su un'unica chiamata rispetto a
// GET/PUT .../settings generici (che restano comunque validi, stesse chiavi
// seo_* sotto — vedi services/site-seo.js). NB per chi genera pagine
// "standalone" (HTML completo, il caso più comune su questa piattaforma):
// questi default e i campi di /pages/:pageId/seo qui sotto valgono solo per
// il rendering delle pagine "wrapped" — le pagine standalone bypassano il
// layout e vanno taggate (canonical/OG/JSON-LD) direttamente nell'HTML
// salvato, vedi AGENT.md sezione SEO.

router.get("/api/agent/sites/:siteId/seo", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    res.json(await getSiteSeoConfig(siteId));
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/seo", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const fields = {};
    for (const f of ["defaultOgImage", "twitterHandle", "robotsExtra"]) {
      if (f in req.body) fields[f] = req.body[f];
    }
    await setSiteSeoConfig(siteId, fields);
    res.json(await getSiteSeoConfig(siteId));
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) { next(err); }
});

// ── Guide ──────────────────────────────────────────────────────────────────

router.get("/api/agent/guide", requireAuth, requireAgent, async (req, res) => {
  try {
    res.type("text/markdown").send(readLocaleMarkdown(res.locals.lang || "en", "AGENT.md"));
  } catch {
    res.status(500).json({ error: res.locals.t("api.common.guideUnavailable") });
  }
});

// ── Ingest URL ─────────────────────────────────────────────────────────────

const ingestSchema = z.object({
  url: z.string().url(),
  site_id: z.number().int().positive().optional(),
});

router.post("/api/agent/ingest", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const { url, site_id } = ingestSchema.parse(req.body);

    if (site_id && !await canAccessSite(req.user, site_id)) {
      return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });
    }

    const { ingestUrl } = await import("../services/ingest.js");
    const result = await ingestUrl(url);

    query(
      `INSERT INTO ingest_log (site_id, user_id, source_url, result_type, title, word_count, media_urls_found)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [site_id || null, req.user.sub, url, result.type, result.title, result.word_count, result.media_urls.length]
    ).catch(() => {});

    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidUrl"), details: err.errors });
    next(err);
  }
});

// ── Trascrizione media ─────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/media/:filename/transcribe", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbiddenSite") });

    const { filename } = req.params;
    if (!filename || filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: res.locals.t("api.media.invalidFilename") });
    }

    const mediaPath = path.join(getSiteDir(siteId), filename);

    if (!fs.existsSync(mediaPath)) {
      return res.status(404).json({ error: res.locals.t("api.media.fileNotFoundInLibrary") });
    }

    const ext = path.extname(filename).toLowerCase();
    const isMedia = /\.(mp4|mp3|mov|m4a|ogg|webm|wav|mkv)$/.test(ext);
    if (!isMedia) {
      return res.status(400).json({ error: res.locals.t("api.media.notAudioVideo") });
    }

    const tmpWav = mediaPath + ".transcribe_tmp.wav";
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i", mediaPath,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        tmpWav,
      ], { timeout: 120000 });
    } catch (ffErr) {
      // In produzione niente dettagli ffmpeg interni
      const detail = config.nodeEnv === "production" ? "" : ffErr.message;
      return res.status(422).json({ error: res.locals.t("api.media.cannotExtractAudio") + detail });
    }

    const openaiKey = config.openaiApiKey;
    if (openaiKey) {
      try {
        const wavBuffer = fs.readFileSync(tmpWav);
        const formData = new FormData();
        formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
        formData.append("model", "whisper-1");
        formData.append("language", req.body.language || "it");

        const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${openaiKey}` },
          body: formData,
          signal: AbortSignal.timeout(120000),
        });

        if (!whisperRes.ok) throw new Error(`Whisper API error: ${whisperRes.status}`);

        const whisperData = await whisperRes.json();

        // Unlink SOLO a successo confermato: se throwiamo prima (API error, parse
        // fallito), il catch sotto deve ancora poter rinominare tmpWav come wav
        // salvato (fallback documentato) — con l'unlink qui, quel rename
        // fallirebbe con ENOENT e la richiesta finirebbe in 500.
        try { fs.unlinkSync(tmpWav); } catch { /* già rimosso */ }

        return res.json({ transcribed: true, text: whisperData.text, filename, wav_path: null });
      } catch (whisperErr) {
        const wavFilename = path.basename(tmpWav);
        const wavDest = path.join(getSiteDir(siteId), wavFilename);
        fs.renameSync(tmpWav, wavDest);

        return res.json({
          transcribed: false, text: null, filename,
          wav_url: `/media/${siteId}/${wavFilename}`,
          // Solo messaggio generico: whisperErr.message può contenere path
          // interni/dettagli API (il global handler in produzione li nasconde).
          error: res.locals.t("api.media.whisperUnavailable"),
        });
      }
    }

    const wavFilename = path.basename(tmpWav);
    const wavDest = path.join(getSiteDir(siteId), wavFilename);
    fs.renameSync(tmpWav, wavDest);

    res.json({
      transcribed: false, text: null, filename,
      wav_url: `/media/${siteId}/${wavFilename}`,
      message: res.locals.t("api.media.wavExtractedNoTranscription"),
    });
  } catch (err) { next(err); }
});

// ── Template ───────────────────────────────────────────────────────────────

const templateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional().default(""),
  content: z.string().min(1),
});

router.get("/api/agent/sites/:siteId/templates", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      `SELECT id, name, description, placeholders, created_at, updated_at
       FROM templates WHERE site_id = $1 ORDER BY name`,
      [siteId]
    )).rows;

    res.json({ templates: rows });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/templates", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const data = templateSchema.parse(req.body);
    const { extractPlaceholders } = await import("../services/template-renderer.js");
    const placeholders = extractPlaceholders(data.content);

    const result = await query(
      `INSERT INTO templates (site_id, name, description, content, placeholders)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [siteId, data.name, data.description, data.content, JSON.stringify(placeholders)]
    );
    res.status(201).json({ template: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.templates.nameExists") });
    next(err);
  }
});

router.get("/api/agent/sites/:siteId/templates/:templateId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const row = (await query(
      "SELECT * FROM templates WHERE id = $1 AND site_id = $2",
      [req.params.templateId, siteId]
    )).rows[0];
    if (!row) return res.status(404).json({ error: res.locals.t("api.templates.notFound") });
    res.json({ template: row });
  } catch (err) { next(err); }
});

const instantiateSchema = z.object({
  url_path: z.string().min(1),
  title: z.string().optional().default(""),
  published: z.boolean().optional().default(false),
  values: z.record(z.string()).optional().default({}),
});

router.post("/api/agent/sites/:siteId/templates/:templateId/instantiate", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const template = (await query(
      "SELECT * FROM templates WHERE id = $1 AND site_id = $2",
      [req.params.templateId, siteId]
    )).rows[0];
    if (!template) return res.status(404).json({ error: res.locals.t("api.templates.notFound") });

    const data = instantiateSchema.parse(req.body);
    const urlPath = normalizeUrlPath(data.url_path);

    const { renderTemplate } = await import("../services/template-renderer.js");
    const content = renderTemplate(template.content, data.values);

    const result = await query(
      `INSERT INTO pages (site_id, url_path, title, content, layout_mode, published)
       VALUES ($1, $2, $3, $4, 'standalone', $5) RETURNING *`,
      [siteId, urlPath, data.title || template.name, content, data.published]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: result.rows[0].id,
      action: "create",
      newData: { url_path: urlPath, from_template: template.id, template_name: template.name, source: "agent" },
      ipAddress: req.ip,
    });

    res.status(201).json({ page: result.rows[0], template_used: template.name });
    if (data.published) exportPublishedPages({ siteId, pageIds: [result.rows[0].id] }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.message === "URL non valido") return res.status(400).json({ error: res.locals.t("api.common.invalidUrl") });
    if (err.code === "23505") return res.status(409).json({ error: res.locals.t("api.pages.urlExists") });
    next(err);
  }
});

// ── Sezioni atomiche ───────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages/:pageId/sections", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const { parseSections } = await import("../services/sections.js");
    const sections = parseSections(page.content);

    res.json({
      page_id: page.id,
      sections: sections.map(s => ({ name: s.name, content: s.content, content_length: s.content.length })),
      total: sections.length,
    });
  } catch (err) { next(err); }
});

const sectionPatchSchema = z.object({
  content: z.string(),
});

router.patch("/api/agent/sites/:siteId/pages/:pageId/sections/:sectionName", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const page = (await query(
      "SELECT * FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });

    const { content: newSectionContent } = sectionPatchSchema.parse(req.body);
    const { replaceSection } = await import("../services/sections.js");

    let newHtml;
    try {
      newHtml = replaceSection(page.content, req.params.sectionName, newSectionContent);
    } catch (sectionErr) {
      return res.status(404).json({ error: sectionErr.message });
    }

    await query(
      `INSERT INTO page_versions (page_id, user_id, url_path, title, content, layout_mode, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [page.id, req.user.sub, page.url_path, page.title, page.content, page.layout_mode, page.published]
    );

    const result = await query(
      "UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2 RETURNING id, url_path, updated_at",
      [newHtml, page.id]
    );

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "page", entityId: page.id,
      action: "update",
      oldData: { section: req.params.sectionName, source: "agent-section" },
      newData: { section: req.params.sectionName, chars: newSectionContent.length },
      ipAddress: req.ip,
    });

    res.json({ page_id: page.id, section_updated: req.params.sectionName, updated_at: result.rows[0].updated_at });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Variabili di sito ──────────────────────────────────────────────────────

const variableSchema = z.object({
  value: z.string(),
  description: z.string().optional().default(""),
});

const bulkVariablesSchema = z.object({
  // Cap 100 chiavi: prima non c'era limite → body con migliaia di chiavi
  // faceva migliaia di round-trip DB sequenziali in una sola richiesta.
  variables: z.record(z.string()).refine(o => Object.keys(o).length <= 100, {
    message: "Troppe variabili in una chiamata (max 100).",
  }),
});

router.put("/api/agent/sites/:siteId/variables/bulk", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { variables } = bulkVariablesSchema.parse(req.body);
    const keys = Object.keys(variables);
    if (keys.length === 0) return res.status(400).json({ error: res.locals.t("api.variables.atLeastOneRequired") });

    const updated = [];
    const errors = [];

    for (const key of keys) {
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
        errors.push({ key, error: res.locals.t("api.variables.invalidKey") });
        continue;
      }
      try {
        await query(
          `INSERT INTO site_variables (site_id, key, value, description, updated_at)
           VALUES ($1, $2, $3, '', NOW())
           ON CONFLICT (site_id, key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()`,
          [siteId, key, variables[key]]
        );
        updated.push(key);
      } catch (e) {
        errors.push({ key, error: e.message });
      }
    }

    if (updated.length > 0) {
      exportPublishedPages({ siteId }).catch(() => {});
    }

    res.json({ updated, errors });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

router.get("/api/agent/sites/:siteId/variables", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      "SELECT id, key, value, description, updated_at FROM site_variables WHERE site_id = $1 ORDER BY key",
      [siteId]
    )).rows;
    res.json({ variables: rows });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/variables/:key", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const key = req.params.key;
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      return res.status(400).json({ error: res.locals.t("api.variables.invalidKeyChars") });
    }

    const { value, description } = variableSchema.parse(req.body);

    const result = await query(
      `INSERT INTO site_variables (site_id, key, value, description, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (site_id, key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE(NULLIF(EXCLUDED.description, ''), site_variables.description),
           updated_at = NOW()
       RETURNING *`,
      [siteId, key, value, description]
    );

    res.json({ variable: result.rows[0] });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

router.delete("/api/agent/sites/:siteId/variables/:key", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    await query(
      "DELETE FROM site_variables WHERE site_id = $1 AND key = $2",
      [siteId, req.params.key]
    );
    res.json({ deleted: req.params.key });
    exportPublishedPages({ siteId }).catch(() => {});
  } catch (err) { next(err); }
});

// ── Sitemap ────────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/sitemap", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const pages = (await query(
      `SELECT id, url_path, title, layout_mode, published, publish_at, created_at, updated_at
       FROM pages WHERE site_id = $1 ORDER BY url_path`,
      [siteId]
    )).rows;

    const redirects = (await query(
      "SELECT from_path, to_path, code FROM redirects WHERE site_id = $1 ORDER BY from_path",
      [siteId]
    )).rows;

    const snippetCount = (await query(
      "SELECT COUNT(*) AS c FROM snippets WHERE site_id = $1", [siteId]
    )).rows[0].c;

    res.json({
      site_id: siteId,
      pages: {
        published: pages.filter(p => p.published),
        drafts: pages.filter(p => !p.published && !p.publish_at),
        scheduled: pages.filter(p => p.publish_at),
        total: pages.length,
      },
      redirects,
      snippets_total: parseInt(snippetCount),
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── Redirect manager ───────────────────────────────────────────────────────

const redirectSchema = z.object({
  from_path: z.string().min(1),
  to_path: z.string().min(1),
  code: z.number().int().refine(v => [301, 302, 307, 308].includes(v)).optional().default(301),
});

router.get("/api/agent/sites/:siteId/redirects", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      "SELECT * FROM redirects WHERE site_id = $1 ORDER BY from_path", [siteId]
    )).rows;
    res.json({ redirects: rows });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/redirects", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const data = redirectSchema.parse(req.body);
    const fromPath = normalizeUrlPath(data.from_path);
    // Redirect esterno: consentiti SOLO http/https (new URL valido). Un
    // protocollo arbitrario (javascript:, data:, vbscript:) o un URL
    // maleformato sarebbero serviti a ogni visitatore via res.redirect().
    let toPath;
    if (data.to_path.startsWith("http")) {
      try {
        const parsed = new URL(data.to_path);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL non valido");
        toPath = data.to_path;
      } catch {
        throw new Error("URL non valido");
      }
    } else {
      toPath = normalizeUrlPath(data.to_path);
    }

    const result = await query(
      `INSERT INTO redirects (site_id, from_path, to_path, code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id, from_path) DO UPDATE
       SET to_path = EXCLUDED.to_path, code = EXCLUDED.code
       RETURNING *`,
      [siteId, fromPath, toPath, data.code]
    );
    res.status(201).json({ redirect: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    if (err.message === "URL non valido") return res.status(400).json({ error: res.locals.t("api.common.invalidUrl") });
    next(err);
  }
});

router.delete("/api/agent/sites/:siteId/redirects/:redirectId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    await query("DELETE FROM redirects WHERE id = $1 AND site_id = $2", [req.params.redirectId, siteId]);
    res.json({ deleted: parseInt(req.params.redirectId) });
  } catch (err) { next(err); }
});

// ── Form submissions ──────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/forms", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      `SELECT form_slug, COUNT(*) AS total,
              MAX(created_at) AS last_submission
       FROM form_submissions WHERE site_id = $1
       GROUP BY form_slug ORDER BY last_submission DESC`,
      [siteId]
    )).rows;

    res.json({ forms: rows });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/forms/:formSlug/submissions", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const limit = Math.min(parseIntParam(req.query.limit, 50), 200);
    const offset = parseIntParam(req.query.offset, 0);
    const since = req.query.since;

    let queryText = `SELECT id, data, ip_address, referrer, created_at
                     FROM form_submissions WHERE site_id = $1 AND form_slug = $2`;
    const params = [siteId, req.params.formSlug];

    if (since) {
      const sinceDate = new Date(since);
      // new Date("garbage") → Invalid Date → errore Postgres → 500. Ignora il filtro.
      if (Number.isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: res.locals.t("api.common.invalidData") });
      }
      params.push(sinceDate);
      queryText += ` AND created_at >= $${params.length}`;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const rows = (await query(queryText, params)).rows;
    const total = (await query(
      "SELECT COUNT(*) AS c FROM form_submissions WHERE site_id = $1 AND form_slug = $2",
      [siteId, req.params.formSlug]
    )).rows[0].c;

    res.json({ submissions: rows, total: parseInt(total), limit, offset });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/forms/search", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const term = (req.query.q || "").trim();
    if (term.length < 2) return res.status(400).json({ error: res.locals.t("api.forms.searchTermTooShort") });

    const limit = Math.min(parseIntParam(req.query.limit, 100), 500);
    const results = await searchSubmissions(siteId, term, { limit });
    res.json({ results });
  } catch (err) { next(err); }
});

// ── Questionari (quiz con punteggi) ────────────────────────────────────────
// Definizioni in `quizzes` (domande con opzioni a punteggio + soglie di
// verdetto), risultati in `quiz_submissions`. Si integrano nelle pagine con
// {{quiz:slug}} (espanso dal page-renderer come {{form:slug}} e
// {{calendar:slug}}). Il punteggio è sempre ricalcolato server-side al
// submit: i punti inviati dal client servono solo per il feedback immediato.

router.get("/api/agent/sites/:siteId/quizzes", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      `SELECT q.id, q.slug, q.name, q.intro, q.questions, q.thresholds,
              q.submit_label, q.success_message, q.ask_email, q.contact_tag,
              q.redirect_url, q.enabled, q.created_at, q.updated_at,
              COALESCE(s.total, 0) AS total
       FROM quizzes q
       LEFT JOIN (
         SELECT quiz_slug, COUNT(*) AS total FROM quiz_submissions WHERE site_id = $1 GROUP BY quiz_slug
       ) s ON s.quiz_slug = q.slug
       WHERE q.site_id = $1
       ORDER BY q.updated_at DESC`,
      [siteId]
    )).rows;

    res.json({ quizzes: rows });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/quizzes", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const slug = String(req.body.slug || req.body.name || "")
      .toLowerCase().trim()
      .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
      .slice(0, 255);
    const name = String(req.body.name || "").trim().slice(0, 255);
    if (!slug || !name) return res.status(400).json({ error: "Nome e slug sono obbligatori." });

    const questions = sanitizeQuizQuestions(req.body.questions);
    const thresholds = sanitizeQuizThresholds(req.body.thresholds);
    const intro = String(req.body.intro || "").trim().slice(0, 2000);
    const submitLabel = String(req.body.submit_label || "").trim().slice(0, 100) || "Calcola il risultato";
    const successMessage = String(req.body.success_message || "").trim().slice(0, 1000);
    const askEmail = !!req.body.ask_email;
    const contactTag = String(req.body.contact_tag || "").trim().slice(0, 100) || null;
    const redirectUrl = String(req.body.redirect_url || "").trim().slice(0, 500) || null;
    const enabled = req.body.enabled !== false;

    try {
      const result = await query(
        `INSERT INTO quizzes (site_id, slug, name, intro, questions, thresholds, submit_label, success_message, ask_email, contact_tag, redirect_url, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [siteId, slug, name, intro, JSON.stringify(questions), JSON.stringify(thresholds), submitLabel, successMessage, askEmail, contactTag, redirectUrl, enabled]
      );
      const row = (await query("SELECT * FROM quizzes WHERE id = $1 AND site_id = $2", [result.rows[0].id, siteId])).rows[0];
      res.json({ quiz: row });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: `Esiste già un questionario con slug "${slug}" su questo sito.` });
      throw err;
    }
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/quizzes/:quizId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const quizId = parseInt(req.params.quizId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const current = (await query("SELECT * FROM quizzes WHERE id = $1 AND site_id = $2", [quizId, siteId])).rows[0];
    if (!current) return res.status(404).json({ error: res.locals.t("api.common.notFound") });

    const slug = req.body.slug !== undefined
      ? String(req.body.slug).toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 255)
      : current.slug;
    const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 255) : current.name;
    const intro = req.body.intro !== undefined ? String(req.body.intro).trim().slice(0, 2000) : (current.intro || "");
    const questions = req.body.questions !== undefined ? sanitizeQuizQuestions(req.body.questions) : current.questions;
    const thresholds = req.body.thresholds !== undefined ? sanitizeQuizThresholds(req.body.thresholds) : current.thresholds;
    const submitLabel = req.body.submit_label !== undefined ? (String(req.body.submit_label).trim().slice(0, 100) || "Calcola il risultato") : current.submit_label;
    const successMessage = req.body.success_message !== undefined ? String(req.body.success_message).trim().slice(0, 1000) : (current.success_message || "");
    const askEmail = req.body.ask_email !== undefined ? !!req.body.ask_email : current.ask_email;
    const contactTag = req.body.contact_tag !== undefined ? (String(req.body.contact_tag).trim().slice(0, 100) || null) : current.contact_tag;
    const redirectUrl = req.body.redirect_url !== undefined ? (String(req.body.redirect_url).trim().slice(0, 500) || null) : current.redirect_url;
    const enabled = req.body.enabled !== undefined ? !!req.body.enabled : current.enabled;

    if (!slug || !name) return res.status(400).json({ error: "Nome e slug sono obbligatori." });

    try {
      await query(
        `UPDATE quizzes SET slug = $1, name = $2, intro = $3, questions = $4, thresholds = $5,
           submit_label = $6, success_message = $7, ask_email = $8, contact_tag = $9,
           redirect_url = $10, enabled = $11, updated_at = NOW()
         WHERE id = $12 AND site_id = $13`,
        [slug, name, intro, JSON.stringify(questions), JSON.stringify(thresholds), submitLabel, successMessage, askEmail, contactTag, redirectUrl, enabled, quizId, siteId]
      );
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: `Esiste già un questionario con slug "${slug}" su questo sito.` });
      throw err;
    }
    const row = (await query("SELECT * FROM quizzes WHERE id = $1 AND site_id = $2", [quizId, siteId])).rows[0];
    res.json({ quiz: row });
  } catch (err) { next(err); }
});

router.delete("/api/agent/sites/:siteId/quizzes/:quizId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const quizId = parseInt(req.params.quizId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const existing = (await query("SELECT id FROM quizzes WHERE id = $1 AND site_id = $2", [quizId, siteId])).rows[0];
    if (!existing) return res.status(404).json({ error: res.locals.t("api.common.notFound") });

    await query("DELETE FROM quizzes WHERE id = $1 AND site_id = $2", [quizId, siteId]);
    res.json({ deleted: quizId });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/quizzes/:quizSlug/submissions", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const limit = Math.min(parseIntParam(req.query.limit, 50), 200);
    const offset = parseIntParam(req.query.offset, 0);
    const since = req.query.since;

    let queryText = `SELECT id, data, total_points, result_title, ip_address, referrer, created_at
                     FROM quiz_submissions WHERE site_id = $1 AND quiz_slug = $2`;
    const params = [siteId, req.params.quizSlug];

    if (since) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: res.locals.t("api.common.invalidData") });
      }
      params.push(sinceDate);
      queryText += ` AND created_at >= $${params.length}`;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const rows = (await query(queryText, params)).rows;
    const total = (await query(
      "SELECT COUNT(*) AS c FROM quiz_submissions WHERE site_id = $1 AND quiz_slug = $2",
      [siteId, req.params.quizSlug]
    )).rows[0].c;

    res.json({ submissions: rows, total: parseInt(total), limit, offset });
  } catch (err) { next(err); }
});


// Nessuna tabella dedicata: l'email viene dedotta dai campi tipo 'email' dei
// form creati col builder (euristica sul nome campo per i form scritti a
// mano) e gli invii raggruppati al volo — vedi services/contacts.js.

router.get("/api/agent/sites/:siteId/contacts", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const tag = (req.query.tag || "").trim() || null;
    const contacts = await aggregateContacts(siteId, { tag });
    res.json({ contacts });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/contacts/tags", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    res.json({ tags: await listTags(siteId) });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/contacts/:email", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { timeline, contact } = await getContactTimeline(siteId, req.params.email);
    if (timeline.length === 0) return res.status(404).json({ error: res.locals.t("api.forms.contactNotFound") });

    res.json({ email: req.params.email.trim().toLowerCase(), submissions: timeline, ...contact });
  } catch (err) { next(err); }
});

// Tag/stato/note: unico modo per farli sopravvivere è persisterli — non sono
// derivabili dai dati inviati (vedi services/contacts.js). Se il contatto
// non esiste ancora lo crea (setContactFields fa upsert, stesso comportamento
// della UI admin).
router.put("/api/agent/sites/:siteId/contacts/:email", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const current = await getContactRecord(siteId, req.params.email);
    const tags = Array.isArray(req.body.tags) ? req.body.tags.map(String).slice(0, 20) : current.tags;
    const status = typeof req.body.status === "string" ? req.body.status.slice(0, 100) : current.status;
    const notes = typeof req.body.notes === "string" ? req.body.notes.slice(0, 5000) : current.notes;
    const value_estimate = typeof req.body.value_estimate === "number" ? req.body.value_estimate : current.value_estimate;

    await setContactFields(siteId, req.params.email, { tags, status, notes, value_estimate });
    res.json({ email: req.params.email.trim().toLowerCase(), tags, status, notes, value_estimate });
  } catch (err) { next(err); }
});

// ── Diritti GDPR (accesso/portabilità, cancellazione) ──────────────────────

router.get("/api/agent/sites/:siteId/contacts/:email/export", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    res.json(await exportContactData(siteId, req.params.email));
  } catch (err) { next(err); }
});

// Cancellazione reale e permanente, non un soft-delete — vedi
// services/privacy.js. Audit-loggata come le altre azioni distruttive.
router.delete("/api/agent/sites/:siteId/contacts/:email", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const normalized = req.params.email.trim().toLowerCase();
    const deleted = await eraseContactData(siteId, normalized);

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "contact", action: "gdpr_erase",
      oldData: { email: normalized, deleted },
      ipAddress: req.ip,
    });

    res.json({ email: normalized, deleted });
  } catch (err) { next(err); }
});

// ── Changelog leggibile ────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/changelog", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const limit = Math.min(parseIntParam(req.query.limit, 50), 200);
    const since = req.query.since;

    let queryText = `
      SELECT al.id, al.entity_type, al.action, al.old_data, al.new_data, al.created_at,
             u.name AS user_name, u.email AS user_email
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.site_id = $1
    `;
    const params = [siteId];

    if (since) {
      const sinceDate = new Date(since);
      // new Date("garbage") → Invalid Date → errore Postgres → 500. Ignora il filtro.
      if (Number.isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: res.locals.t("api.common.invalidData") });
      }
      params.push(sinceDate);
      queryText += ` AND al.created_at >= $${params.length}`;
    }

    queryText += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const rows = (await query(queryText, params)).rows;

    const changelog = rows.map(entry => ({
      id: entry.id,
      message: buildChangelogMessage(entry),
      entity_type: entry.entity_type,
      action: entry.action,
      user: entry.user_name || entry.user_email || "Agente AI",
      created_at: entry.created_at,
    }));

    res.json({ changelog, total: changelog.length });
  } catch (err) { next(err); }
});

// ── Deploy hook ────────────────────────────────────────────────────────────

const deploySchema = z.object({
  // max 30: coerente col limite del purge Cloudflare in deploy.js — email e
  // audit log registrano tutte le pagine, senza cap diventavano enormi.
  pages: z.array(z.string()).max(30).optional().default([]),
  note: z.string().optional().default(""),
});

router.post("/api/agent/sites/:siteId/deploy", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    if (req.user.role !== "superadmin" && req.user.role !== "admin") {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }

    const site = (await query(
      "SELECT id, name, domain FROM sites WHERE id = $1", [siteId]
    )).rows[0];
    if (!site) return res.status(404).json({ error: res.locals.t("api.common.siteNotFound") });

    const data = deploySchema.parse(req.body);
    const { deploysite } = await import("../services/deploy.js");

    const results = await deploysite({
      siteId,
      siteName: site.name,
      siteDomain: site.domain,
      userId: req.user.sub,
      pages: data.pages,
      note: data.note,
    });

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "site", entityId: siteId,
      action: "deploy",
      newData: { pages_count: data.pages.length, note: data.note, cloudflare: results.cloudflare, webhook: results.webhook, email: results.email, source: "agent" },
      ipAddress: req.ip,
    });

    const hasErrors = results.errors.length > 0;
    res.status(hasErrors ? 207 : 200).json({
      deployed: true,
      results,
      message: hasErrors ? `Deploy completato con ${results.errors.length} avviso/i` : "Deploy completato con successo",
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Bulk import ─────────────────────────────────────────────────────────────

const bulkImportSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(50),
  site_id: z.number().int().positive(),
  prefix_path: z.string().optional().default("/imported/"),
});

router.post("/api/agent/sites/bulk-import", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const { urls, site_id, prefix_path } = bulkImportSchema.parse(req.body);
    if (!await canAccessSite(req.user, site_id)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const { ingestUrl } = await import("../services/ingest.js");
    const results = [];
    for (const url of urls) {
      try {
        const ingest = await ingestUrl(url);
        const parsed = new URL(url);
        // Il fallback "page" va applicato al pathname (che può diventare "" per
        // URL root), NON a tutta la concatenazione (prefix_path è sempre
        // truthy → codice morto).
        const urlPathPart = parsed.pathname.replace(/\.html?$/, "").replace(/\/$/, "") || "page";
        const pathSegment = prefix_path + urlPathPart;
        const cleanPath = normalizeUrlPath(pathSegment);
        const pageResult = await query(
          `INSERT INTO pages (site_id, url_path, title, content, published)
           VALUES ($1, $2, $3, $4, false) RETURNING *`,
          [site_id, cleanPath, ingest.title || "Imported", `<h1>${ingest.title || "Imported"}</h1>\n${ingest.text ? "<p>" + ingest.text.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>" : ""}`]
        );
        results.push({ url, page: pageResult.rows[0], status: "created" });
      } catch (err) {
        results.push({ url, status: "error", error: err.message });
      }
    }
    res.json({ created: results.filter(r => r.status === "created").length, errors: results.filter(r => r.status === "error").length, results });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Rewrite ─────────────────────────────────────────────────────────────────

const rewriteSchema = z.object({
  text: z.string().min(1).max(100000),
  action: z.enum(["shorter", "longer", "professional", "simple", "friendly"]),
});

router.post("/api/agent/rewrite", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const { text, action } = rewriteSchema.parse(req.body);
    const { rewriteText } = await import("../services/llm.js");
    const rewritten = await rewriteText(text, action);
    res.json({ original: text, rewritten });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

// ── Social posts ────────────────────────────────────────────────────────────

const socialPostSchema = z.object({
  page_id: z.number().int().positive(),
  platform: z.enum(["twitter", "linkedin", "facebook"]),
  message: z.string().min(1).max(2800),
  scheduled_at: z.string().datetime({ offset: true }),
});

router.post("/api/agent/sites/:siteId/social-posts", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const data = socialPostSchema.parse(req.body);
    const pageCheck = await query("SELECT id FROM pages WHERE id = $1 AND site_id = $2", [data.page_id, siteId]);
    if (pageCheck.rows.length === 0) {
      return res.status(404).json({ error: res.locals.t("api.common.pageNotFound") });
    }
    const result = await query(
      `INSERT INTO social_posts (page_id, platform, message, scheduled_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.page_id, data.platform, data.message, new Date(data.scheduled_at)]
    );
    res.status(201).json({ post: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData"), details: err.errors });
    next(err);
  }
});

router.get("/api/agent/sites/:siteId/social-posts", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const rows = (await query(
      `SELECT sp.*, p.url_path, p.title FROM social_posts sp
       JOIN pages p ON p.id = sp.page_id
       WHERE p.site_id = $1 ORDER BY sp.scheduled_at DESC`,
      [siteId]
    )).rows;
    res.json({ posts: rows });
  } catch (err) { next(err); }
});

// ── Internal links ──────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages/:pageId/internal-links", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const page = (await query(
      "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!page) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });
    const { suggestInternalLinks } = await import("../services/internal-links.js");
    const suggestions = await suggestInternalLinks(siteId, page.content, page.id);
    res.json({ suggestions });
  } catch (err) { next(err); }
});

// ── Rendered diff ───────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/pages/:pageId/rendered-diff/:versionId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const current = (await query(
      "SELECT content FROM pages WHERE id = $1 AND site_id = $2",
      [req.params.pageId, siteId]
    )).rows[0];
    if (!current) return res.status(404).json({ error: res.locals.t("api.pages.notFound") });
    const oldVer = (await query(
      "SELECT content FROM page_versions WHERE id = $1 AND page_id = $2",
      [req.params.versionId, req.params.pageId]
    )).rows[0];
    if (!oldVer) return res.status(404).json({ error: res.locals.t("api.pages.versionNotFound") });
    const changes = diffLines(oldVer.content, current.content);
    res.json({
      page_id: parseInt(req.params.pageId),
      version_id: parseInt(req.params.versionId),
      changes,
      stats: {
        additions: changes.filter(c => c.added).reduce((s, c) => s + c.count, 0),
        removals: changes.filter(c => c.removed).reduce((s, c) => s + c.count, 0),
        unchanged: changes.filter(c => !c.added && !c.removed).reduce((s, c) => s + c.count, 0),
      },
    });
  } catch (err) { next(err); }
});

// ── Stats views ─────────────────────────────────────────────────────────────

router.get("/api/agent/sites/:siteId/stats/views", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const days = Math.min(parseIntParam(req.query.days, 30), 365);
    const since = new Date(Date.now() - days * 86400000);
    const rows = (await query(
      `SELECT p.id, p.url_path, p.title,
              COUNT(pv.id) AS views,
              COUNT(DISTINCT pv.session_id) AS unique_visitors,
              MAX(pv.visited_at) AS last_visit
       FROM pages p
       LEFT JOIN page_views pv ON pv.page_id = p.id AND pv.visited_at >= $2
       WHERE p.site_id = $1
       GROUP BY p.id, p.url_path, p.title
       ORDER BY views DESC`,
      [siteId, since]
    )).rows;
    res.json({ site_id: siteId, days, pages: rows });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/stats/views/timeline", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const days = Math.min(parseIntParam(req.query.days, 30), 365);
    const since = new Date(Date.now() - days * 86400000);
    const rows = (await query(
      `SELECT DATE(visited_at) AS giorno, COUNT(*) AS views, COUNT(DISTINCT session_id) AS unici
       FROM page_views pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.site_id = $1 AND pv.visited_at >= $2
       GROUP BY DATE(visited_at)
       ORDER BY giorno`,
      [siteId, since]
    )).rows;
    res.json({ site_id: siteId, days, timeline: rows });
  } catch (err) { next(err); }
});

// ── Backup ──────────────────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/backup", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    // Il backup contiene l'intero dataset del sito (utenti, contatti, iscritti
    // newsletter, settings): sensibile, solo admin/superadmin.
    if (req.user.role !== "superadmin" && req.user.role !== "admin") {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }
    const siteInfo = (await query("SELECT id, name, domain FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!siteInfo) return res.status(404).json({ error: res.locals.t("api.common.siteNotFound") });

    const [pages, snippets, settings, redirects, templates, seo, socialPosts, variables, domains, modules, forms, submissions, contacts, calls, callAvailability, calendars, ingestLog, nlSettings, nlSubscribers, nlCampaigns, nlSequences, nlSteps, nlSends, nlSeqSends, auditLogs, siteUsers] = await Promise.all([
      query("SELECT * FROM pages WHERE site_id = $1", [siteId]),
      query("SELECT * FROM snippets WHERE site_id = $1", [siteId]),
      query("SELECT * FROM settings WHERE site_id = $1", [siteId]),
      query("SELECT * FROM redirects WHERE site_id = $1", [siteId]),
      query("SELECT * FROM templates WHERE site_id = $1", [siteId]),
      query("SELECT ps.* FROM page_seo ps JOIN pages p ON p.id = ps.page_id WHERE p.site_id = $1", [siteId]),
      query("SELECT sp.* FROM social_posts sp JOIN pages p ON p.id = sp.page_id WHERE p.site_id = $1", [siteId]),
      query("SELECT * FROM site_variables WHERE site_id = $1", [siteId]),
      query("SELECT * FROM site_domains WHERE site_id = $1", [siteId]),
      query("SELECT * FROM site_modules WHERE site_id = $1", [siteId]),
      query("SELECT * FROM forms WHERE site_id = $1", [siteId]),
      query("SELECT fs.* FROM form_submissions fs JOIN forms f ON f.id = fs.form_id WHERE f.site_id = $1", [siteId]),
      query("SELECT * FROM contacts WHERE site_id = $1", [siteId]),
      query("SELECT * FROM calls WHERE site_id = $1", [siteId]),
      query("SELECT * FROM call_availability WHERE site_id = $1", [siteId]),
      query("SELECT * FROM calendars WHERE site_id = $1", [siteId]),
      query("SELECT * FROM ingest_log WHERE site_id = $1", [siteId]),
      query("SELECT * FROM newsletter_settings WHERE site_id = $1", [siteId]),
      query("SELECT * FROM newsletter_subscribers WHERE site_id = $1", [siteId]),
      query("SELECT * FROM newsletter_campaigns WHERE site_id = $1", [siteId]),
      query("SELECT * FROM newsletter_sequences WHERE site_id = $1", [siteId]),
      query("SELECT ns.* FROM newsletter_sequence_steps ns JOIN newsletter_sequences sq ON sq.id = ns.sequence_id WHERE sq.site_id = $1", [siteId]),
      query("SELECT s.* FROM newsletter_sends s JOIN newsletter_campaigns c ON c.id = s.campaign_id WHERE c.site_id = $1", [siteId]),
      query("SELECT ss.* FROM newsletter_sequence_sends ss JOIN newsletter_sequence_steps st ON st.id = ss.step_id JOIN newsletter_sequences sq ON sq.id = st.sequence_id WHERE sq.site_id = $1", [siteId]),
      query("SELECT * FROM audit_log WHERE site_id = $1", [siteId]),
      query("SELECT * FROM users WHERE site_id = $1", [siteId]),
    ]);

    // Sanitizzazione secret PRIMA dello zip: il backup è scaricabile da
    // qualsiasi agent con accesso al sito (non solo superadmin) e non deve
    // contenere credenziali in chiaro. smtp_pass → flag "impostato", token
    // conferma newsletter → null (le stesse policy di masking delle GET).
    const sanitizedNlSettings = (nlSettings.rows || []).map(r => ({ ...r, smtp_pass: r.smtp_pass ? "***" : null, smtp_pass_set: !!r.smtp_pass }));
    const sanitizedNlSubscribers = (nlSubscribers.rows || []).map(r => ({ ...r, token: null }));

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="site_${siteId}_backup.zip"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    // Handler error obbligatorio: senza listener, un errore su uno stream (es.
    // client che si disconnette a metà download) fa crashare l'intero processo.
    archive.on("error", (err) => { next(err); });
    archive.pipe(res);
    archive.append(JSON.stringify({
      site: siteInfo, pages: pages.rows, snippets: snippets.rows,
      settings: settings.rows, redirects: redirects.rows,
      templates: templates.rows, seo: seo.rows, social_posts: socialPosts.rows,
      site_variables: variables.rows, site_domains: domains.rows,
      site_modules: modules.rows, forms: forms.rows,
      form_submissions: submissions.rows, contacts: contacts.rows,
      calls: calls.rows, call_availability: callAvailability.rows, calendars: calendars.rows,
      ingest_log: ingestLog.rows,
      newsletter_settings: sanitizedNlSettings, newsletter_subscribers: sanitizedNlSubscribers,
      newsletter_campaigns: nlCampaigns.rows, newsletter_sequences: nlSequences.rows,
      newsletter_sequence_steps: nlSteps.rows, newsletter_sends: nlSends.rows,
      newsletter_sequence_sends: nlSeqSends.rows,
      audit_log: auditLogs.rows, users: siteUsers.rows,
    }, null, 2), { name: "data.json" });
    const dir = getSiteDir(siteId);
    if (fs.existsSync(dir)) archive.directory(dir, "media");
    archive.finalize();
  } catch (err) { next(err); }
});

// ── Static Export agent ──────────────────────────────────────────────────────

router.post("/api/agent/sites/:siteId/export-static", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    const result = await exportPublishedPages({ siteId });
    res.json({ ok: true, exported: result.exported, errors: result.errors });
  } catch (err) { next(err); }
});

router.post("/api/agent/export-static-all", requireAuth, requireAgent, async (req, res, next) => {
  try {
    // Operazione globale (tutti i siti + symlink domini): solo superadmin.
    if (req.user.role !== "superadmin") {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }
    const result = await fullExport();
    res.json({ ok: true, totalExported: result.totalExported, totalErrors: result.totalErrors });
  } catch (err) { next(err); }
});

// ── Newsletter ─────────────────────────────────────────────────────────────
// Setup una tantum (SMTP + firma), poi due tipi di invio: campagne broadcast
// (una tantum, agli iscritti confermati al momento dell'invio) e sequenze
// evergreen (step ordinati, ognuno N giorni dopo la conferma iscrizione).
// Il contenuto (campagne e step) passa per lo stesso motore snippet/variabili
// delle pagine (expandSnippets) al momento dell'invio: {{snippet:nome}} e
// {{var:chiave}} sono il "costruttore". Vedi AGENT.md sezione NEWSLETTER.

router.get("/api/agent/sites/:siteId/newsletter/settings", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const row = (await query("SELECT * FROM newsletter_settings WHERE site_id = $1", [siteId])).rows[0];
    if (!row) return res.json({ configured: false });
    res.json({
      configured: true,
      smtp_host: row.smtp_host,
      smtp_port: row.smtp_port,
      smtp_user: row.smtp_user,
      smtp_pass_set: !!row.smtp_pass,
      from_email: row.from_email,
      rate_per_hour: row.rate_per_hour,
      signature_html: row.signature_html,
    });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/newsletter/settings", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const existing = (await query("SELECT * FROM newsletter_settings WHERE site_id = $1", [siteId])).rows[0] || {};
    const {
      smtp_host = existing.smtp_host || "",
      smtp_port = existing.smtp_port || 465,
      smtp_user = existing.smtp_user || "",
      smtp_pass = existing.smtp_pass || "",
      from_email = existing.from_email || "",
      rate_per_hour = existing.rate_per_hour || 100,
      signature_html = existing.signature_html || "",
    } = req.body;

    await query(
      `INSERT INTO newsletter_settings (site_id, smtp_host, smtp_port, smtp_user, smtp_pass, from_email, rate_per_hour, signature_html, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (site_id) DO UPDATE SET
         smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, smtp_user = EXCLUDED.smtp_user,
         smtp_pass = EXCLUDED.smtp_pass, from_email = EXCLUDED.from_email, rate_per_hour = EXCLUDED.rate_per_hour,
         signature_html = EXCLUDED.signature_html, updated_at = NOW()`,
      [siteId, smtp_host, parseInt(smtp_port, 10) || 465, smtp_user, smtp_pass, from_email, Math.max(1, parseInt(rate_per_hour, 10) || 100), signature_html]
    );
    resetSiteTransporter(siteId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Email template per sito (livello sito) ───────────────────────────────
// Ogni tipo di email di sistema può avere subject/body custom per sito:
//   newsletter_confirm | newsletter_test | call_confirmation | call_reminder
//   | form_notify | deploy_notify | review_reminder
// Se non configurato, l'email usa il default standard (locales o default
// hardcoded). Placeholder disponibili nei template: {siteName}, {siteDomain},
// {confirmUrl}, {cancelUrl}, {when}, {formSlug}, {fieldsHtml}, {title}, {url},
// {urlPath}, {date}, {pageList}, {note}, {siteId}.
router.get("/api/agent/sites/:siteId/email-templates", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    res.json(await listEmailTemplates(siteId));
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/email-templates/:kind", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const kind = String(req.params.kind || "");
    if (!EMAIL_TEMPLATE_KINDS.includes(kind)) {
      return res.status(400).json({ error: "Tipo di email non supportato" });
    }

    const { subject, body_html } = req.body;
    const tpl = await setEmailTemplate(siteId, kind, { subject, body_html });
    res.json({ ok: true, template: tpl });
  } catch (err) { next(err); }
});

router.delete("/api/agent/sites/:siteId/email-templates/:kind", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const kind = String(req.params.kind || "");
    await deleteEmailTemplate(siteId, kind);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/newsletter/subscribers", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const limit = Math.min(parseIntParam(req.query.limit, 100), 1000);
    const offset = parseIntParam(req.query.offset, 0);

    let sql = "SELECT id, email, status, subscribed_at, confirmed_at, unsubscribed_at FROM newsletter_subscribers WHERE site_id = $1";
    const params = [siteId];
    if (req.query.status) {
      params.push(req.query.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY subscribed_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const rows = (await query(sql, params)).rows;
    res.json({ subscribers: rows, limit, offset });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/newsletter/subscribers/stats", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      "SELECT status, COUNT(*) AS c FROM newsletter_subscribers WHERE site_id = $1 GROUP BY status",
      [siteId]
    )).rows;
    const stats = { pending: 0, confirmed: 0, unsubscribed: 0 };
    rows.forEach(r => { stats[r.status] = parseInt(r.c, 10); });
    res.json(stats);
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/newsletter/subscribers", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const email = (req.body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: res.locals.t("api.common.invalidEmail") });
    const confirmed = req.body.confirmed === true;

    // BLOCCO A: verifica email prima di inserire/aggiornare (se non è già confermato).
    if (!confirmed) {
      const verification = await verifySubscriberEmail(email);
      if (verification.status === "blocked") {
        return res.status(400).json({ error: "Email non valida (blocco anti-spam)", details: verification.reason });
      }
    }

    // Se lo SMTP del sito non è configurato, l'iscritto va comunque creato ma
    // resta bloccato in "pending" per sempre (nessuna email di conferma può
    // partire): segnalato nella risposta invece di fallire silenziosamente.
    const emailConfigured = confirmed || !!(await getSiteEmailConfig(siteId));

    const existing = (await query(
      "SELECT id, token, status FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [siteId, email]
    )).rows[0];

    if (existing) {
      if (confirmed) {
        await query(
          "UPDATE newsletter_subscribers SET status = 'confirmed', confirmed_at = NOW(), unsubscribed_at = NULL WHERE id = $1",
          [existing.id]
        );
      } else if (existing.status === "unsubscribed") {
        // Re-verify anche per re-subscribe da unsubscribed (già fatto sopra, ma per chiarezza).
        const verification = await verifySubscriberEmail(email);
        await query(
          "UPDATE newsletter_subscribers SET status = 'pending', unsubscribed_at = NULL, verification = $2, verified_at = NOW() WHERE id = $1",
          [existing.id, verification.status]
        );
        sendConfirmationEmail(siteId, email, existing.token).catch(err => logger.error(`Invio email conferma newsletter fallito (site=${siteId}, email=${email}): ${err.message}`));
      }
      return res.json({ ok: true, id: existing.id, email_configured: emailConfigured });
    }

    // Nuova iscrizione: verifica ancora (ridondante, ma esplicito).
    const verification = await verifySubscriberEmail(email);
    const token = crypto.randomBytes(32).toString("hex");
    const result = await query(
      `INSERT INTO newsletter_subscribers (site_id, email, status, token, confirmed_at, verification, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
      [siteId, email, confirmed ? "confirmed" : "pending", token, confirmed ? new Date() : null, verification.status]
    );
    if (!confirmed) {
      sendConfirmationEmail(siteId, email, token).catch(err => logger.error(`Invio email conferma newsletter fallito (site=${siteId}, email=${email}): ${err.message}`));
    }
    res.json({ ok: true, id: result.rows[0].id, status: confirmed ? "confirmed" : "pending", email_configured: emailConfigured, verification: verification.status });
  } catch (err) { next(err); }
});

router.delete("/api/agent/sites/:siteId/newsletter/subscribers/:email", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const result = await query(
      `UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = NOW()
       WHERE site_id = $1 AND email = $2 RETURNING id`,
      [siteId, req.params.email.toLowerCase()]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: res.locals.t("api.newsletter.subscriberNotFound") });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/newsletter/complaints", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const email = (req.body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: res.locals.t("api.common.invalidEmail") });
    }

    await query(
      "INSERT INTO newsletter_complaints (site_id, email, source) VALUES ($1, $2, $3)",
      [siteId, email, req.body.source || "fbl"]
    );

    await query(
      `UPDATE newsletter_subscribers
       SET status = 'suppressed', suppressed_at = NOW(), suppression_reason = 'complaint'
       WHERE site_id = $1 AND email = $2 AND status IN ('confirmed', 'pending')`,
      [siteId, email]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/newsletter/metrics", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const metrics = await getComplaintMetrics(siteId);
    res.json(metrics);
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/newsletter/campaigns", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      `SELECT c.*, COUNT(s.id) AS sent_count, COUNT(s.opened_at) AS opened_count
       FROM newsletter_campaigns c LEFT JOIN newsletter_sends s ON s.campaign_id = c.id
       WHERE c.site_id = $1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [siteId]
    )).rows;
    res.json({ campaigns: rows });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/newsletter/campaigns/:campaignId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const campaign = (await query(
      "SELECT * FROM newsletter_campaigns WHERE id = $1 AND site_id = $2",
      [req.params.campaignId, siteId]
    )).rows[0];
    if (!campaign) return res.status(404).json({ error: res.locals.t("api.newsletter.campaignNotFound") });
    res.json({ campaign });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/newsletter/campaigns", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const { subject, html_content } = req.body;
    if (!subject) return res.status(400).json({ error: res.locals.t("api.newsletter.subjectRequired") });
    const targetTag = typeof req.body.target_tag === "string" ? req.body.target_tag.trim().slice(0, 100) || null : null;

    const result = await query(
      `INSERT INTO newsletter_campaigns (site_id, subject, html_content, status, created_by, target_tag)
       VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING *`,
      [siteId, subject, html_content || "", req.user.sub, targetTag]
    );
    res.json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/newsletter/campaigns/:campaignId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const campaign = (await query(
      "SELECT * FROM newsletter_campaigns WHERE id = $1 AND site_id = $2",
      [req.params.campaignId, siteId]
    )).rows[0];
    if (!campaign) return res.status(404).json({ error: res.locals.t("api.newsletter.campaignNotFound") });
    if (campaign.status !== "draft") return res.status(400).json({ error: res.locals.t("api.newsletter.onlyDraftCampaignsEditable") });

    // target_tag: stringa vuota rimuove la segmentazione (torna a "tutti"),
    // undefined lascia invariato — coerente con subject/html_content (??).
    const targetTag = req.body.target_tag === undefined
      ? campaign.target_tag
      : (String(req.body.target_tag).trim().slice(0, 100) || null);

    const result = await query(
      "UPDATE newsletter_campaigns SET subject = $1, html_content = $2, target_tag = $3 WHERE id = $4 RETURNING *",
      [req.body.subject ?? campaign.subject, req.body.html_content ?? campaign.html_content, targetTag, campaign.id]
    );
    res.json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/newsletter/campaigns/:campaignId/send", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    // L'invio di una campagna newsletter è privilegiato: solo admin/superadmin.
    if (req.user.role !== "superadmin" && req.user.role !== "admin") {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }

    const campaign = (await query(
      "SELECT * FROM newsletter_campaigns WHERE id = $1 AND site_id = $2",
      [req.params.campaignId, siteId]
    )).rows[0];
    if (!campaign) return res.status(404).json({ error: res.locals.t("api.newsletter.campaignNotFound") });
    if (campaign.status !== "draft") return res.status(400).json({ error: res.locals.t("api.newsletter.campaignAlreadyQueued") });

    const emailConfig = await getSiteEmailConfig(siteId);
    if (!emailConfig) return res.status(400).json({ error: res.locals.t("api.newsletter.smtpNotConfiguredSend") });

    await query("UPDATE newsletter_campaigns SET status = 'sending' WHERE id = $1", [campaign.id]);
    res.json({ ok: true, status: "sending" });
  } catch (err) { next(err); }
});

// Invio di prova: se "email" non è nel body, usa l'email dell'account
// agente/utente autenticato. Non conta come invio reale (non tocca
// newsletter_sends), non richiede che la campagna sia in bozza.
router.post("/api/agent/sites/:siteId/newsletter/campaigns/:campaignId/test-send", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const campaign = (await query(
      "SELECT * FROM newsletter_campaigns WHERE id = $1 AND site_id = $2",
      [req.params.campaignId, siteId]
    )).rows[0];
    if (!campaign) return res.status(404).json({ error: res.locals.t("api.newsletter.campaignNotFound") });

    const email = (req.body.email || req.user.email || "").trim();
    if (!email) return res.status(400).json({ error: res.locals.t("api.newsletter.emailRequiredNoAccount") });

    const settings = (await query("SELECT signature_html FROM newsletter_settings WHERE site_id = $1", [siteId])).rows[0];
    if (!settings) return res.status(400).json({ error: res.locals.t("api.newsletter.smtpNotConfiguredShort") });

    await sendTestEmail(siteId, email, campaign.subject, campaign.html_content, settings.signature_html);
    res.json({ ok: true, sent_to: email });
  } catch (err) { next(err); }
});

router.delete("/api/agent/sites/:siteId/newsletter/campaigns/:campaignId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const result = await query(
      "DELETE FROM newsletter_campaigns WHERE id = $1 AND site_id = $2 AND status = 'draft' RETURNING id",
      [req.params.campaignId, siteId]
    );
    if (result.rowCount === 0) return res.status(400).json({ error: res.locals.t("api.newsletter.campaignNotFoundOrNotDraft") });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/newsletter/sequences", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const rows = (await query(
      `SELECT sq.*, COUNT(st.id) AS step_count
       FROM newsletter_sequences sq LEFT JOIN newsletter_sequence_steps st ON st.sequence_id = sq.id
       WHERE sq.site_id = $1 GROUP BY sq.id ORDER BY sq.created_at DESC`,
      [siteId]
    )).rows;
    res.json({ sequences: rows });
  } catch (err) { next(err); }
});

router.post("/api/agent/sites/:siteId/newsletter/sequences", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: res.locals.t("api.newsletter.nameRequired") });
    const targetTag = typeof req.body.target_tag === "string" ? req.body.target_tag.trim().slice(0, 100) || null : null;

    const result = await query(
      "INSERT INTO newsletter_sequences (site_id, name, target_tag) VALUES ($1, $2, $3) RETURNING *",
      [siteId, name, targetTag]
    );
    res.json({ sequence: result.rows[0] });
  } catch (err) { next(err); }
});

router.get("/api/agent/sites/:siteId/newsletter/sequences/:sequenceId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const sequence = (await query(
      "SELECT * FROM newsletter_sequences WHERE id = $1 AND site_id = $2",
      [req.params.sequenceId, siteId]
    )).rows[0];
    if (!sequence) return res.status(404).json({ error: res.locals.t("api.newsletter.sequenceNotFound") });

    const steps = (await query(
      `SELECT st.*, COUNT(se.id) AS sent_count, COUNT(se.opened_at) AS opened_count
       FROM newsletter_sequence_steps st LEFT JOIN newsletter_sequence_sends se ON se.step_id = st.id
       WHERE st.sequence_id = $1 GROUP BY st.id ORDER BY st.step_order`,
      [sequence.id]
    )).rows;
    res.json({ sequence, steps });
  } catch (err) { next(err); }
});

router.put("/api/agent/sites/:siteId/newsletter/sequences/:sequenceId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const sequence = (await query(
      "SELECT * FROM newsletter_sequences WHERE id = $1 AND site_id = $2",
      [req.params.sequenceId, siteId]
    )).rows[0];
    if (!sequence) return res.status(404).json({ error: res.locals.t("api.newsletter.sequenceNotFound") });

    const name = req.body.name ?? sequence.name;
    const active = typeof req.body.active === "boolean" ? req.body.active : sequence.active;
    const targetTag = req.body.target_tag === undefined
      ? sequence.target_tag
      : (String(req.body.target_tag).trim().slice(0, 100) || null);
    const result = await query(
      "UPDATE newsletter_sequences SET name = $1, active = $2, target_tag = $3, updated_at = NOW() WHERE id = $4 RETURNING *",
      [name, active, targetTag, sequence.id]
    );
    res.json({ sequence: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete("/api/agent/sites/:siteId/newsletter/sequences/:sequenceId", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const result = await query(
      "DELETE FROM newsletter_sequences WHERE id = $1 AND site_id = $2 RETURNING id",
      [req.params.sequenceId, siteId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: res.locals.t("api.newsletter.sequenceNotFound") });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Sostituzione atomica di tutti gli step: 1 chiamata per definire l'intera
// sequenza (coerente con la filosofia bulk del resto dell'API agente).
// Gli step il cui step_order coincide con uno già esistente vengono
// aggiornati in place (stesso id), non ricreati: newsletter_sequence_sends
// (FK su step_id) mantiene così lo storico invii e gli iscritti già avanzati
// non ricevono di nuovo gli step che avevano già ricevuto. Solo gli step il
// cui step_order non è più presente nella nuova definizione vengono cancellati.
router.put("/api/agent/sites/:siteId/newsletter/sequences/:sequenceId/steps", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const sequence = (await query(
      "SELECT * FROM newsletter_sequences WHERE id = $1 AND site_id = $2",
      [req.params.sequenceId, siteId]
    )).rows[0];
    if (!sequence) return res.status(404).json({ error: res.locals.t("api.newsletter.sequenceNotFound") });

    const steps = Array.isArray(req.body.steps) ? req.body.steps : null;
    if (!steps || steps.length === 0) return res.status(400).json({ error: res.locals.t("api.newsletter.stepsRequired") });
    for (const s of steps) {
      if (!s.subject || typeof s.step_order !== "number" || typeof s.delay_days !== "number") {
        return res.status(400).json({ error: res.locals.t("api.newsletter.stepFieldsRequired") });
      }
    }
    // step_order duplicati nella stessa definizione: due step con lo stesso
    // ordine condividono lo stesso id in existingIdByOrder → il secondo
    // UPDATE sovrascrive il primo (perdita silenziosa di uno step).
    const seenOrders = new Set();
    for (const s of steps) {
      if (seenOrders.has(s.step_order)) {
        return res.status(400).json({ error: res.locals.t("api.newsletter.duplicateStepOrder") });
      }
      seenOrders.add(s.step_order);
    }

    const existing = (await query(
      "SELECT id, step_order FROM newsletter_sequence_steps WHERE sequence_id = $1",
      [sequence.id]
    )).rows;
    const existingIdByOrder = new Map(existing.map(r => [r.step_order, r.id]));
    const keepOrders = new Set(steps.map(s => s.step_order));

    for (const row of existing) {
      if (!keepOrders.has(row.step_order)) {
        await query("DELETE FROM newsletter_sequence_steps WHERE id = $1", [row.id]);
      }
    }

    for (const s of steps) {
      const existingId = existingIdByOrder.get(s.step_order);
      if (existingId) {
        await query(
          `UPDATE newsletter_sequence_steps SET delay_days = $1, subject = $2, html_content = $3 WHERE id = $4`,
          [s.delay_days, s.subject, s.html_content || "", existingId]
        );
      } else {
        await query(
          `INSERT INTO newsletter_sequence_steps (sequence_id, step_order, delay_days, subject, html_content)
           VALUES ($1, $2, $3, $4, $5)`,
          [sequence.id, s.step_order, s.delay_days, s.subject, s.html_content || ""]
        );
      }
    }

    const saved = (await query(
      "SELECT * FROM newsletter_sequence_steps WHERE sequence_id = $1 ORDER BY step_order",
      [sequence.id]
    )).rows;
    res.json({ ok: true, steps: saved });
  } catch (err) { next(err); }
});

// Invio di prova di un singolo step: se "email" non è nel body, usa l'email
// dell'account agente/utente autenticato. Non tocca newsletter_sequence_sends.
router.post("/api/agent/sites/:siteId/newsletter/sequences/:sequenceId/steps/:stepId/test-send", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: res.locals.t("api.common.forbidden") });

    const sequence = (await query(
      "SELECT * FROM newsletter_sequences WHERE id = $1 AND site_id = $2",
      [req.params.sequenceId, siteId]
    )).rows[0];
    if (!sequence) return res.status(404).json({ error: res.locals.t("api.newsletter.sequenceNotFound") });

    const step = (await query(
      "SELECT * FROM newsletter_sequence_steps WHERE id = $1 AND sequence_id = $2",
      [req.params.stepId, sequence.id]
    )).rows[0];
    if (!step) return res.status(404).json({ error: res.locals.t("api.newsletter.stepNotFound") });

    const email = (req.body.email || req.user.email || "").trim();
    if (!email) return res.status(400).json({ error: res.locals.t("api.newsletter.emailRequiredNoAccount") });

    const settings = (await query("SELECT signature_html FROM newsletter_settings WHERE site_id = $1", [siteId])).rows[0];
    if (!settings) return res.status(400).json({ error: res.locals.t("api.newsletter.smtpNotConfiguredShort") });

    await sendTestEmail(siteId, email, step.subject, step.html_content, settings.signature_html);
    res.json({ ok: true, sent_to: email });
  } catch (err) { next(err); }
});

// Route CRM (segmenti, workflow, scoring, task, funnel, preferenze, merge,
// pipeline, tracking) — registrate sullo stesso router così l'introspezione
// MCP (discoverTools) le scopre automaticamente.
import { registerCrmRoutes } from "./crm-agent.js";
import { registerRecurringRoutes } from "./agent-recurring.js";
import { registerRbacRoutes } from "./agent-rbac.js";
import { registerAgentRuntimeRoutes } from "./agent-runtime.js";
import { registerKbRoutes } from "./agent-kb.js";
import { registerAgentBuilderRoutes } from "./agent-builder.js";
import { registerHitlRoutes } from "./agent-hitl.js";
import { registerCallSummariesRoutes } from "./agent-callsummaries.js";
import { registerSuggestionsRoutes } from "./agent-suggestions.js";
import { registerWebhooksRoutes } from "./agent-webhooks.js";
import { registerOauthRoutes } from "./agent-oauth.js";
import { registerCalendarSyncRoutes } from "./agent-calendar-sync.js";
import { registerPaymentsRoutes } from "./agent-payments.js";
import { registerExportRoutes } from "./agent-export.js";
import { registerDashboardRoutes } from "./agent-dashboard.js";
import { registerReportsRoutes } from "./agent-reports.js";
import { registerSandboxRoutes } from "./agent-sandbox.js";
import { registerBackupJobsRoutes } from "./agent-backup-jobs.js";
import { registerChannelLimitsRoutes } from "./agent-limits.js";
import { registerClientServicesRoutes } from "./agent-client-services.js";
import { registerTrackedLinksRoutes } from "./agent-tracked-links.js";
import { registerAccessGrantsRoutes } from "./agent-access-grants.js";
import { registerTickRoutes } from "./agent-tick.js";
import { registerSourceSyncRoutes } from "./agent-source-sync.js";
import { registerGhlPushRoutes } from "./agent-ghl-push.js";
registerCrmRoutes(router);
registerRecurringRoutes(router);
registerTickRoutes(router);
registerRbacRoutes(router);
registerAgentRuntimeRoutes(router);
registerKbRoutes(router);
registerAgentBuilderRoutes(router);
registerHitlRoutes(router);
registerCallSummariesRoutes(router);
registerSuggestionsRoutes(router);
registerWebhooksRoutes(router);
registerOauthRoutes(router);
registerCalendarSyncRoutes(router);
registerPaymentsRoutes(router);
registerExportRoutes(router);
registerDashboardRoutes(router);
registerReportsRoutes(router);
registerSandboxRoutes(router);
registerBackupJobsRoutes(router);
registerChannelLimitsRoutes(router);
registerClientServicesRoutes(router);
registerTrackedLinksRoutes(router);
registerSourceSyncRoutes(router);
registerGhlPushRoutes(router);
registerAccessGrantsRoutes(router);

export default router;
