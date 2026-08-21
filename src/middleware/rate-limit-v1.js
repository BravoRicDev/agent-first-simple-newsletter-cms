import rateLimit from "express-rate-limit";

// ─────────────────────────────────────────────────────────────────────────
// Rate limiting per la surface /v1 API-compatibile ( "API compatibili con
// CRM diffusi" ).
//
// Due limiters statici (creati a init, non dentro handler):
// - generalLimiter: 120 req/min per GET
// - writeLimiter:   60 req/min per POST/PUT/DELETE
//
// Il middleware v1RateLimiter() sceglie il limiter giusto in base al metodo.
// Loopback (127.0.0.1, ::1) esente da rate limit.
// standardHeaders: true, legacyHeaders: false.
//
// Config per-tenant via tenant_config key=rate_limits e' un'estensione
// FUTURA da aggiungere quando serve — per ora limiters statici.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minuto
const DEFAULT_GENERAL_MAX = 120;
const DEFAULT_WRITE_MAX = 60;

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

const generalLimiter = rateLimit({
  windowMs: DEFAULT_WINDOW_MS,
  max: DEFAULT_GENERAL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isLoopback(req.ip),
  message: { error: "Troppe richieste. Riprova piu tardi." },
});

const writeLimiter = rateLimit({
  windowMs: DEFAULT_WINDOW_MS,
  max: DEFAULT_WRITE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isLoopback(req.ip),
  message: { error: "Troppe richieste. Riprova piu tardi." },
});

export function v1RateLimiter() {
  return (req, res, next) => {
    const isWrite = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
    const limiter = isWrite ? writeLimiter : generalLimiter;
    return limiter(req, res, next);
  };
}