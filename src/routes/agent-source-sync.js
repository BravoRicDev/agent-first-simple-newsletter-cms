import { query } from "../db.js";
import { encryptSecret } from "../services/crypto.js";
import { runSync, isRunning } from "../services/source-sync/index.js";
import { loadConfig } from "../services/source-sync/client.js";
import { canAccessSite, requireAgent } from "./agent-helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// API agent — Source Sync (import dal CRM sorgente).
// Config con token CIFRATO write-only: mai in risposta, solo token_set.
// Docs: docs/SOURCE_SYNC_PLAN.md.
// ─────────────────────────────────────────────────────────────────────────

// Valida che base_url sia http(s) per prevenire SSRF (javascript:, ftp:, ecc).
// Scelta: validazione al save time — così client.js è minimal.
function validateBaseUrl(baseUrl) {
  const url = String(baseUrl || "").trim();
  if (!url) return { valid: false, error: "baseUrl richiesto" };
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { valid: false, error: "baseUrl deve essere http(s)" };
    }
    if (!parsed.hostname) {
      return { valid: false, error: "baseUrl hostname non valido" };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: "baseUrl malformato" };
  }
}

function maskConfig(row) {
  if (!row) return null;
  return {
    siteId: row.site_id,
    enabled: row.enabled,
    baseUrl: row.base_url,
    locationId: row.location_id,
    companyId: row.company_id,
    tokenSet: !!row.token_enc,
    matchByEmail: row.match_by_email,
    handleDeletes: row.handle_deletes,
    throttleRps: row.throttle_rps,
    dailyQuota: row.daily_quota,
    budgetPercent: row.budget_percent,
    minIntervalMinutes: row.min_interval_minutes,
    callsDate: row.calls_date,
    callsCount: row.calls_count,
  };
}

export function registerSourceSyncRoutes(router) {
  // ── Config ────────────────────────────────────────────────────────────
  router.get("/api/agent/sites/:siteId/source-sync/config", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      const r = await query("SELECT * FROM source_sync_config WHERE site_id = $1", [siteId]);
      res.json({ config: maskConfig(r.rows[0]) });
    } catch (err) { next(err); }
  });

  router.put("/api/agent/sites/:siteId/source-sync/config", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      const b = req.body || {};

      // Valida base_url per SSRF
      if (b.baseUrl && b.baseUrl.trim().length > 0) {
        const validation = validateBaseUrl(b.baseUrl);
        if (!validation.valid) {
          return res.status(400).json({ error: `baseUrl: ${validation.error}` });
        }
      }

      const current = (
        await query("SELECT * FROM source_sync_config WHERE site_id = $1", [siteId])
      ).rows[0];

      let tokenEnc = current?.token_enc || null;
      if (typeof b.token === "string" && b.token.length > 0) {
        tokenEnc = encryptSecret(b.token); // write-only: mai restituito
      }

      const val = (k, d) => (b[k] !== undefined ? b[k] : current ? current[d ?? k] : d);

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
          !!val("enabled"),
          String(val("baseUrl") || ""),
          String(val("locationId") || ""),
          String(val("companyId") || ""),
          tokenEnc,
          val("matchByEmail") !== false,
          val("handleDeletes") === true,
          Math.max(1, parseInt(val("throttleRps"), 10) || 8),
          Math.max(1000, parseInt(val("dailyQuota"), 10) || 250000),
          Math.min(100, Math.max(1, parseInt(val("budgetPercent"), 10) || 30)),
          Math.max(1, parseInt(val("minIntervalMinutes"), 10) || 15),
        ]
      );
      const fresh = (
        await query("SELECT * FROM source_sync_config WHERE site_id = $1", [siteId])
      ).rows[0];
      res.json({ config: maskConfig(fresh) });
    } catch (err) { next(err); }
  });

  // ── Trigger manuale (background): risponde subito con started ─────────
  router.post("/api/agent/sites/:siteId/source-sync/run", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      if (await isRunning(siteId)) {
        return res.status(409).json({ error: "Sync già in corso" });
      }
      const resources = Array.isArray(req.body?.resources) ? req.body.resources : null;
      const dryRun = req.body?.dryRun === true;
      runSync(siteId, { resources, dryRun }).catch(() => {});
      res.json({ started: true });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/source-sync/stop-waiting", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      res.json({ running: await isRunning(siteId) });
    } catch (err) { next(err); }
  });

  // ── Runs + budget ─────────────────────────────────────────────────────
  router.get("/api/agent/sites/:siteId/source-sync/runs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);
      const runs = (
        await query(
          `SELECT id, mode, resources, status, started_at, finished_at, stats, errors
             FROM source_sync_runs WHERE site_id = $1
            ORDER BY started_at DESC LIMIT $2`,
          [siteId, limit]
        )
      ).rows;
      const state = (
        await query("SELECT * FROM source_sync_state WHERE site_id = $1", [siteId])
      ).rows;
      res.json({ runs, state });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/source-sync/budget", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      const cfgRow = await loadConfig(siteId);
      if (!cfgRow) return res.json({ budget: null });
      const budgetMax = Math.floor((cfgRow.daily_quota * cfgRow.budget_percent) / 100);
      const sameDay =
        cfgRow.calls_date &&
        new Date(cfgRow.calls_date).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
      res.json({
        budget: {
          date: cfgRow.calls_date,
          callsToday: sameDay ? cfgRow.calls_count : 0,
          max: budgetMax,
          remaining: Math.max(0, budgetMax - (sameDay ? cfgRow.calls_count : 0)),
        },
      });
    } catch (err) { next(err); }
  });
}
