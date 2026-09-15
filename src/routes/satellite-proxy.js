import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAgent } from "./agent-helpers.js";
import { invokeSatellite, ProxyError } from "../services/satelliteProxy.js";

// ─────────────────────────────────────────────────────────────────────────
// Rotta proxy sincrono tra satelliti (F1).
//
//   POST /api/agent/satellites/:name/invoke
//     body: { method?, path, data? }  → { ok: true, status, data }
//
// Auth: qualsiasi satellite autenticato con agtok_ o sessione agent. Il
// gate scope globale lascia passare i token read-only solo perché la rotta
// è in READ_ONLY_POST_ALLOWLIST: il controllo per-endpoint vero avviene
// dentro invokeSatellite (endpoint dichiarati "write" → 403 senza write).
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

router.post("/api/agent/satellites/:name/invoke", requireAuth, requireAgent, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await invokeSatellite({
      caller: req.user,
      targetName: req.params.name,
      method: body.method || "GET",
      path: body.path,
      data: body.data,
    });
    res.json({ ok: true, status: result.status, data: result.body });
  } catch (err) {
    if (err instanceof ProxyError) {
      return res.status(err.status).json({ ok: false, error: err.code, ...err.extra });
    }
    next(err);
  }
});

export default router;
