import { Router } from "express";
import { handleIncoming } from "../services/webhooks.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 35 — Webhook IN: endpoint PUBBLICO (nessuna auth, nessun
// rate-limit: la sicurezza è il token nel path). Il padre monta questo
// modulo in src/index.js con express.json() già globale; qui il body JSON
// è garantito. Token non valido → 401.
// ─────────────────────────────────────────────────────────────────────────

async function handleIncomingRequest(req, res, next) {
  try {
    const siteId = parseInt(req.params.siteId, 10);
    const token = String(req.params.token || "");
    if (!Number.isInteger(siteId) || siteId < 1 || !token) {
      return res.status(401).json({ error: "Non autorizzato" });
    }
    const result = await handleIncoming(siteId, token, req.body || {});
    if (!result) return res.status(401).json({ error: "Non autorizzato" });
    res.json({ ok: true, received: result.received, actions: result.actions });
  } catch (err) { next(err); }
}

export function registerPublicWebhookRoutes(router) {
  router.post("/webhooks/in/:siteId/:token", handleIncomingRequest);
}

// Router autonomo esportato per i test (montato su app.use senza auth) e
// per chi preferisce app.use(publicWebhookRouter) a registerPublic...().
export const publicWebhookRouter = Router();
registerPublicWebhookRoutes(publicWebhookRouter);
