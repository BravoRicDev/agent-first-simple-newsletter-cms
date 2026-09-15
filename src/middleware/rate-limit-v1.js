import rateLimit from "express-rate-limit";
import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Rate limiting per la surface /v1 API-compatibile ("API compatibili con
// CRM diffusi").
//
// Config per-tenant via tenant_config key=rate_limits:
//   { "generalMax": 200, "writeMax": 100, "windowMs": 60000 }
// I limiti di default sono 120 GET/min, 60 write/min.
//
// keyGenerator include siteId per isolamento tenant: ogni tenant ha il
// proprio rate limit anche se arriva dallo stesso IP.
// Loopback (127.0.0.1, ::1) esente da rate limit (configurabile con
// v1RateLimiter({ skipLoopback: false }) per test).
//
// Cache del config refreshata ogni 60 secondi dal DB.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minuto
const DEFAULT_GENERAL_MAX = 120;
const DEFAULT_WRITE_MAX = 60;
const CACHE_TTL_MS = 60 * 1000;

// Cache in-memory condivisa tra tutte le istanze: Map<siteId, {generalMax, writeMax}>
let configCache = new Map();
let cacheLastRefreshed = 0;
let refreshTimer = null;

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export async function refreshConfigCache() {
  try {
    const result = await query(
      "SELECT site_id, value FROM tenant_config WHERE key = $1",
      ["rate_limits"]
    );
    const newCache = new Map();
    for (const row of result.rows) {
      const v = row.value;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        newCache.set(row.site_id, {
          generalMax: v.generalMax ?? DEFAULT_GENERAL_MAX,
          writeMax: v.writeMax ?? DEFAULT_WRITE_MAX,
        });
      }
    }
    configCache = newCache;
    cacheLastRefreshed = Date.now();
  } catch {
    // Mantieni cache esistente se il DB non risponde
  }
}

function getLimits(siteId) {
  // Fire-and-forget refresh se cache scaduta
  if (Date.now() - cacheLastRefreshed > CACHE_TTL_MS) {
    refreshConfigCache().catch(() => {});
  }
  const limits = configCache.get(siteId);
  return limits || { generalMax: DEFAULT_GENERAL_MAX, writeMax: DEFAULT_WRITE_MAX };
}

export function v1RateLimiter(options = {}) {
  const skipLoopback = options.skipLoopback !== false; // default: true

  // Lazy init: refresh + timer solo alla prima chiamata
  if (!refreshTimer) {
    refreshTimer = true;
    refreshConfigCache().catch(() => {});
    setInterval(() => {
      refreshConfigCache().catch(() => {});
    }, CACHE_TTL_MS);
  }

  // Ogni chiamata crea una propria istanza rateLimit cosi che skip loopback
  // sia coerente con chi la invoca (test possono passare skipLoopback: false).
  // La cache dei limiti (configCache) e' condivisa tra istanze.
  return rateLimit({
    windowMs: DEFAULT_WINDOW_MS,
    max: (req) => {
      const siteId = req.tenant?.siteId;
      if (!siteId) return DEFAULT_GENERAL_MAX;
      const limits = getLimits(siteId);
      const isWrite = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
      return isWrite ? limits.writeMax : limits.generalMax;
    },
    keyGenerator: (req) => {
      const siteId = req.tenant?.siteId || "anon";
      return `${siteId}:${req.ip}`;
    },
    skip: skipLoopback ? (req) => isLoopback(req.ip) : () => false,
    message: { error: "Troppe richieste. Riprova piu tardi." },
    standardHeaders: true,
    legacyHeaders: false,
  });
}