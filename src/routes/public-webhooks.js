import { Router } from "express";
import rateLimit from "express-rate-limit";
import { handleIncoming } from "../services/webhooks.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 35 — Webhook IN: endpoint PUBBLICO (nessuna auth, il token nel
// path è l'unica barriera). Il padre monta questo modulo in src/index.js
// con express.json() già globale; qui il body JSON è garantito.
// Token non valido → 401.
// ─────────────────────────────────────────────────────────────────────────

// Limiter per-IP (contenimento generico)
const webhookInIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Troppe richieste per IP. Riprova tra un minuto." },
});

// Limiter per-token (chiave = token nel path): previene abuso anche con IP rotanti
// Se il token è compromesso, non può essere usato per floodare da migliaia di IP
const webhookInTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 req/min per token (più alto del per-IP perché n8n può inviare burst)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.params.token || req.ip,
  message: { error: "Troppe richieste per questo token. Riprova tra un minuto." },
  skipFailedRequests: true,
  skipSuccessfulRequests: false,
});

// Middleware per limitare la dimensione del body inbound (100 KB max)
// Viene montato PRIMA del body parser globale che ha 50 MB
function inboundBodyLimit(req, res, next) {
  const len = req.headers["content-length"];
  if (len && parseInt(len, 10) > 100 * 1024) {
    return res.status(413).json({ error: "Body troppo grande (max 100 KB)" });
  }
  next();
}

async function handleIncomingRequest(req, res, next) {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const token = String(req.params.token || "");
    if (!Number.isInteger(siteId) || siteId < 1 || !token) {
      return res.status(401).json({ error: "Non autorizzato" });
    }
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const signature = req.headers["x-webhook-signature"] || "";
    const result = await handleIncoming(siteId, token, req.body || {}, { ip, signature });
    if (!result) return res.status(401).json({ error: "Non autorizzato" });
    // Rispondi anche con info di rejection se presente
    const response = { ok: true, received: result.received, actions: result.actions };
    if (result.rejected) response.rejected = result.rejected;
    res.json(response);
  } catch (err) { next(err); }
}

export function registerPublicWebhookRoutes(router) {
  // Ordine: limiter IP → limiter token → body limit → handler
  router.post("/webhooks/in/:siteId/:token",
    webhookInIpLimiter,
    webhookInTokenLimiter,
    inboundBodyLimit,
    handleIncomingRequest
  );
}

// Router autonomo esportato per i test (montato su app.use senza auth) e
// per chi preferisce app.use(publicWebhookRouter) a registerPublic...().
export const publicWebhookRouter = Router();
registerPublicWebhookRoutes(publicWebhookRouter);