import { Router } from "express";
import { sendError, getLocationId } from "./_helpers.js";
import { registerOAuthApp } from "../../services/oauth-provider.js";
import { logger } from "../../services/logger.js";

// Onda G2 — OAuth provider clone: registrazione app terze, authorization code
// flow, token exchange + refresh, revoca. Contratto: piano §5 onda G.
// Questo router monta DENTRO api-clone (tenant-scoped). Le rotte pubbliche
// (authorize, token, userinfo, revoke) sono in src/routes/public-oauth-provider.js.

const router = Router();

// POST /oauth/apps — registra una nuova app OAuth per il tenant (site-scoped).
// Richiede: dialetto tenant (apiDialect middleware applicato globale —
// sitekey_ O agtok_: NON aggiungere requireAuth, romperebbe i sitekey).
// Corpo: { name, redirectUris: [...], scopes: [...] }
router.post("/oauth/apps", async (req, res) => {
  try {
    const { name, redirectUris, scopes } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return sendError(res, 400, "Nome app richiesto");
    }
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return sendError(res, 400, "Almeno un redirect URI richiesto");
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      return sendError(res, 400, "Almeno un scope richiesto");
    }

    const locationId = await getLocationId(req.tenant);
    const { app } = await registerOAuthApp(req.tenant.siteId, name.trim(), redirectUris, scopes);

    res.status(201).json({ app: { ...app, locationId } });
  } catch (err) {
    logger.error(`POST /oauth/apps error: ${err.message}`);
    sendError(res, 500, "Errore registrazione app");
  }
});

export default router;
