import { Router } from "express";
import { exchangeCode, verifyState } from "../services/oauth.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 36 — OAuth Google: callback PUBBLICO di ritorno da Google
// (nessuna auth: è Google che ci ridirige qui dopo il consenso).
//
// Lo state generato da getAuthUrl è `${siteId}:${appId}:${hex random}:${hmac}`
// (firmato HMAC con JWT_SECRET): il callback lo verifica (struttura + firma)
// per ritrovare l'app e il sito senza parametri extra e per escludere state
// contraffatti (login CSRF). State malformato o non firmato → 400.
// Esito ok → redirect a /admin; errore → redirect a /login?error=oauth.
// Il padre monta questo modulo in src/index.js (come publicWebhookRouter).
// ─────────────────────────────────────────────────────────────────────────

const SUPPORTED_PROVIDERS = new Set(["google"]);

async function handleCallback(req, res, next) {
  try {
    const provider = String(req.params.provider || "");
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: "Provider non supportato" });
    }
    const code = String(req.query.code || "");
    const decoded = verifyState(req.query.state);
    if (!code || !decoded) {
      return res.status(400).json({ error: "state o code mancante/invalido" });
    }
    const result = await exchangeCode(decoded.siteId, {
      app_id: decoded.appId,
      code,
      state: String(req.query.state),
    });
    if (result.error) return res.redirect("/login?error=oauth");
    res.redirect("/admin");
  } catch (err) { next(err); }
}

export function registerPublicOauthRoutes(router) {
  router.get("/oauth/callback/:provider", handleCallback);
}

// Router autonomo esportato per i test (montato su app.use senza auth) e
// per chi preferisce app.use(publicOauthRouter) a registerPublic...().
export const publicOauthRouter = Router();
registerPublicOauthRoutes(publicOauthRouter);
