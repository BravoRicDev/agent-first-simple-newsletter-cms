import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { encryptSecret } from "../services/crypto.js";
import { loadConfig } from "../services/source-sync/client.js";
import { runSync, isRunning } from "../services/source-sync/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Admin UI — Source Sync (import dal CRM sorgente).
// Config per tenant con token cifrato write-only + trigger manuale +
// storico run. Docs: docs/SOURCE_SYNC_PLAN.md.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// Valida che base_url sia http(s) per prevenire SSRF (javascript:, ftp:, ecc).
// Scelta: validazione al save time in admin-import (form HTML) e agent-source-sync
// (API JSON) — così il client.js può essere minimal e fidato (base_url già validato).
function validateBaseUrl(baseUrl) {
  const url = String(baseUrl || "").trim();
  if (!url) return { valid: false, error: "base_url richiesto" };
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { valid: false, error: "base_url deve essere http(s)" };
    }
    if (!parsed.hostname) {
      return { valid: false, error: "base_url hostname non valido" };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: "base_url malformato" };
  }
}

function resolveSiteId(req) {
  if (req.user.role === "superadmin" && req.query.site_id) {
    return parseInt(req.query.site_id, 10);
  }
  return req.user.site_id ? parseInt(req.user.site_id, 10) : null;
}

async function buildPageData(siteId) {
  const cfgRow = await loadConfig(siteId);
  const runs = (
    await query(
      `SELECT id, mode, status, started_at, finished_at, stats, errors
         FROM source_sync_runs WHERE site_id = $1
        ORDER BY started_at DESC LIMIT 10`,
      [siteId]
    )
  ).rows;
  const state = (
    await query("SELECT * FROM source_sync_state WHERE site_id = $1 ORDER BY resource_type", [siteId])
  ).rows;

  let budget = null;
  if (cfgRow) {
    const max = Math.floor((cfgRow.daily_quota * cfgRow.budget_percent) / 100);
    const sameDay =
      cfgRow.calls_date &&
      new Date(cfgRow.calls_date).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
    budget = {
      callsToday: sameDay ? cfgRow.calls_count : 0,
      max,
    };
  }
  return { config: cfgRow, runs, state, budget };
}

router.get("/admin/import", requireAuth, async (req, res, next) => {
  try {
    const siteId = resolveSiteId(req);
    if (!siteId) {
      return res.render("admin/import", {
        siteId: null, config: null, runs: [], state: [], budget: null,
        running: false, saved: false, error: "Nessun sito associato all'utente.",
      });
    }
    const data = await buildPageData(siteId);
    res.render("admin/import", {
      siteId,
      running: await isRunning(siteId),
      saved: req.query.saved === "1",
      error: req.query.error || null,
      ...data,
    });
  } catch (err) { next(err); }
});

router.post("/admin/import/config", requireAuth, async (req, res, next) => {
  try {
    if (!["superadmin", "admin"].includes(req.user.role)) {
      return res.status(403).render("error", { message: "Solo admin/superadmin." });
    }
    const siteId = resolveSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: "Nessun sito." });

    const b = req.body || {};

    // Valida base_url per SSRF
    if (b.base_url && b.base_url.trim().length > 0) {
      const validation = validateBaseUrl(b.base_url);
      if (!validation.valid) {
        return res.status(400).render("error", { message: `base_url: ${validation.error}` });
      }
    }

    const current = (
      await query("SELECT * FROM source_sync_config WHERE site_id = $1", [siteId])
    ).rows[0];

    let tokenEnc = current?.token_enc || null;
    if (typeof b.token === "string" && b.token.trim().length > 0) {
      tokenEnc = encryptSecret(b.token.trim()); // write-only
    }

    await query(
      `INSERT INTO source_sync_config
         (site_id, enabled, base_url, location_id, company_id, token_enc, match_by_email,
          handle_deletes, throttle_rps, daily_quota, budget_percent, min_interval_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (site_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         base_url = EXCLUDED.base_url,
         location_id = EXCLUDED.location_id,
         company_id = EXCLUDED.company_id,
         token_enc = COALESCE(EXCLUDED.token_enc, source_sync_config.token_enc),
         match_by_email = EXCLUDED.match_by_email,
         handle_deletes = EXCLUDED.handle_deletes,
         throttle_rps = EXCLUDED.throttle_rps,
         daily_quota = EXCLUDED.daily_quota,
         budget_percent = EXCLUDED.budget_percent,
         min_interval_minutes = EXCLUDED.min_interval_minutes,
         updated_at = NOW()`,
      [
        siteId,
        b.enabled === "on",
        String(b.base_url || "").trim(),
        String(b.location_id || "").trim(),
        String(b.company_id || "").trim(),
        tokenEnc,
        b.match_by_email === "on",
        b.handle_deletes === "on",
        Math.max(1, parseInt(b.throttle_rps, 10) || 8),
        Math.max(1000, parseInt(b.daily_quota, 10) || 250000),
        Math.min(100, Math.max(1, parseInt(b.budget_percent, 10) || 30)),
        Math.max(1, parseInt(b.min_interval_minutes, 10) || 15),
      ]
    );
    res.redirect(`/admin/import?saved=1${req.user.role === "superadmin" && req.query.site_id ? "&site_id=" + req.query.site_id : ""}`);
  } catch (err) { next(err); }
});

router.post("/admin/import/run", requireAuth, async (req, res, next) => {
  try {
    if (!["superadmin", "admin"].includes(req.user.role)) {
      return res.status(403).render("error", { message: "Solo admin/superadmin." });
    }
    const siteId = resolveSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: "Nessun sito." });
    if (await isRunning(siteId)) {
      return res.redirect("/admin/import?error=" + encodeURIComponent("Sync già in corso"));
    }
    const dryRun = req.body.dry_run === "on";
    // background: il run può durare minuti
    runSync(siteId, { dryRun }).catch(() => {});
    res.redirect("/admin/import");
  } catch (err) { next(err); }
});

export default router;
