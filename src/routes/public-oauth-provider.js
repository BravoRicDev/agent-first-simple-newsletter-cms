import { Router } from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import {
  findAppByClientId,
  createAuthorizationCode,
  consumeAuthorizationCode,
  createTokens,
  validateAccessToken,
  rotateRefreshToken,
  revokeToken,
} from "../services/oauth-provider.js";
import { query } from "../db.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// GET /oauth/authorize — mostra form HTML per autorizzazione utente.
// Query: client_id, redirect_uri, scope, state, response_type (sempre "code")
// Ritorna: HTML form standalone (nojs, nessun layout CMS).
// Errori: 400 JSON se app/redirect_uri invalidi.
// ─────────────────────────────────────────────────────────────────────────
router.get("/oauth/authorize", async (req, res) => {
  const { client_id, redirect_uri, scope, state, response_type } = req.query;

  if (!client_id || !redirect_uri || !scope) {
    return res.status(400).json({
      statusCode: 400,
      message: "client_id, redirect_uri, scope richiesti",
    });
  }

  if (response_type !== "code") {
    return res.status(400).json({
      statusCode: 400,
      message: "response_type must be 'code'",
    });
  }

  try {
    const app = await findAppByClientId(String(client_id));
    if (!app || !app.active) {
      return res.status(400).json({ statusCode: 400, message: "App non trovata o disabilitata" });
    }

    const uris = Array.isArray(app.redirect_uris) ? app.redirect_uris : [];
    if (!uris.includes(String(redirect_uri))) {
      return res.status(400).json({ statusCode: 400, message: "redirect_uri non autorizzato" });
    }

    // HTML form minimo standalone
    const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorizza App</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { font-size: 20px; margin: 0 0 20px; }
    .info { background: #f0f4ff; border-left: 4px solid #4a90e2; padding: 12px; margin-bottom: 20px; font-size: 14px; }
    .scopes { background: #fafafa; padding: 12px; border-radius: 4px; margin-bottom: 20px; font-size: 14px; }
    .scopes-label { font-weight: 500; margin-bottom: 8px; }
    .scope-item { margin: 4px 0; }
    .actions { display: flex; gap: 10px; margin-top: 30px; }
    button { flex: 1; padding: 10px 20px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; font-weight: 500; }
    .approve { background: #4a90e2; color: white; }
    .approve:hover { background: #357abd; }
    .deny { background: #e5e5e5; color: #333; }
    .deny:hover { background: #d0d0d0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Autorizzare questa app?</h1>
    <div class="info">
      <strong>${app.name}</strong> richiede accesso ai tuoi dati.
    </div>
    <div class="scopes">
      <div class="scopes-label">Permessi richiesti:</div>
      ${(Array.isArray(app.scopes) ? app.scopes : []).map((s) => `<div class="scope-item">• ${s}</div>`).join("")}
    </div>
    <form method="POST" action="/oauth/authorize/decision" class="actions">
      <input type="hidden" name="client_id" value="${String(client_id).replace(/"/g, "&quot;")}">
      <input type="hidden" name="redirect_uri" value="${String(redirect_uri).replace(/"/g, "&quot;")}">
      <input type="hidden" name="scope" value="${String(scope).replace(/"/g, "&quot;")}">
      <input type="hidden" name="state" value="${String(state || "").replace(/"/g, "&quot;")}">
      <button type="submit" name="decision" value="approve" class="approve">Approva</button>
      <button type="submit" name="decision" value="deny" class="deny">Nega</button>
    </form>
  </div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    logger.error(`GET /oauth/authorize error: ${err.message}`);
    res.status(500).json({ statusCode: 500, message: "Errore interno" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /oauth/authorize/decision — applica decisione (approve/deny).
// Richiede: Bearer agtok_ (requireAuth middleware) oppure session JWT.
// Corpo: { client_id, redirect_uri, scope, state, decision }
// Successo: 302 redirect a redirect_uri?code=X&state=Y
// Errore: 302 redirect a redirect_uri?error=access_denied&state=Y
// ─────────────────────────────────────────────────────────────────────────
router.post("/oauth/authorize/decision", requireAuth, async (req, res) => {
  const { client_id, redirect_uri, scope, state, decision } = req.body;

  if (!client_id || !redirect_uri || !decision) {
    return res.status(400).json({
      statusCode: 400,
      message: "client_id, redirect_uri, decision richiesti",
    });
  }

  try {
    const app = await findAppByClientId(String(client_id));
    if (!app || !app.active) {
      return res.status(400).json({ statusCode: 400, message: "App non trovata" });
    }

    const uris = Array.isArray(app.redirect_uris) ? app.redirect_uris : [];
    if (!uris.includes(String(redirect_uri))) {
      return res.status(400).json({ statusCode: 400, message: "redirect_uri non autorizzato" });
    }

    if (decision === "deny") {
      const params = new URLSearchParams({ error: "access_denied" });
      if (state) params.append("state", String(state));
      return res.redirect(`${String(redirect_uri)}?${params}`);
    }

    if (decision !== "approve") {
      return res.status(400).json({ statusCode: 400, message: "decision deve essere 'approve' o 'deny'" });
    }

    // Utente approvato — genera authorization code.
    // req.user popolo da requireAuth: ha sub (user_id), site_id (dal token), email, ecc.
    const userId = req.user.sub;
    const siteId = req.user.site_id;

    const code = await createAuthorizationCode(app.id, siteId, userId, String(redirect_uri), String(scope || ""));

    const params = new URLSearchParams({ code });
    if (state) params.append("state", String(state));
    res.redirect(`${String(redirect_uri)}?${params}`);
  } catch (err) {
    logger.error(`POST /oauth/authorize/decision error: ${err.message}`);
    res.status(500).json({ statusCode: 500, message: "Errore interno" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /oauth/token — exchange authorization code per access/refresh token.
// Content-Type: application/x-www-form-urlencoded o application/json
// Corpo: { grant_type, code, client_id, client_secret, redirect_uri }
// Ritorna: { access_token, refresh_token, expires_in, token_type, scope }
// OAuth errori standard: { error: "invalid_client|invalid_grant|..." }
// ─────────────────────────────────────────────────────────────────────────
router.post("/oauth/token", async (req, res) => {
  try {
    const { grant_type, code, client_id, client_secret, refresh_token } = req.body;

    if (grant_type === "authorization_code") {
      // Exchange code per token
      if (!code || !client_id || !client_secret || !req.body.redirect_uri) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "code, client_id, client_secret, redirect_uri richiesti",
        });
      }

      const app = await findAppByClientId(String(client_id));
      if (!app) {
        return res.status(401).json({
          error: "invalid_client",
          error_description: "Client non trovato",
        });
      }

      // Valida secret con timing-safe comparison per prevenire timing attacks.
      // Anche se il secret è hashato, === può rivelare info via microtempi.
      const secretHash = crypto.createHash("sha256").update(String(client_secret)).digest("hex");
      let secretValid;
      try {
        secretValid = crypto.timingSafeEqual(
          Buffer.from(secretHash, "hex"),
          Buffer.from(app.client_secret_hash, "hex")
        );
      } catch {
        secretValid = false;
      }
      if (!secretValid) {
        return res.status(401).json({
          error: "invalid_client",
          error_description: "Client secret non valido",
        });
      }

      // Valida e consuma il code
      const codeResult = await consumeAuthorizationCode(String(code), String(client_id), String(req.body.redirect_uri));
      if (codeResult.error) {
        return res.status(400).json({
          error: codeResult.error,
          error_description: "Authorization code non valido, scaduto o già usato",
        });
      }

      // Crea token
      const tokens = await createTokens(
        codeResult.appId,
        codeResult.siteId,
        codeResult.userId,
        codeResult.scopes
      );

      return res.json({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.expiresIn,
        token_type: tokens.tokenType,
        scope: tokens.scope,
      });
    } else if (grant_type === "refresh_token") {
      // Rotazione refresh token
      if (!refresh_token) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "refresh_token richiesto",
        });
      }

      const result = await rotateRefreshToken(String(refresh_token));
      if (result.error) {
        return res.status(400).json({
          error: result.error,
          error_description: "Refresh token non valido o scaduto",
        });
      }

      return res.json({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_in: result.expiresIn,
        token_type: result.tokenType,
        scope: result.scope,
      });
    } else {
      return res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "grant_type non supportato (authorization_code, refresh_token)",
      });
    }
  } catch (err) {
    logger.error(`POST /oauth/token error: ${err.message}`);
    res.status(500).json({
      error: "server_error",
      error_description: "Errore interno",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /oauth/revoke — revoca un access o refresh token.
// Content-Type: application/x-www-form-urlencoded o application/json
// Corpo: { token }
// Ritorna: 200 { ok: true } sempre (anche se token non trovato, per privacy).
// ─────────────────────────────────────────────────────────────────────────
router.post("/oauth/revoke", async (req, res) => {
  const { token } = req.body;

  try {
    if (token) {
      await revokeToken(String(token));
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error(`POST /oauth/revoke error: ${err.message}`);
    res.status(500).json({ error: "server_error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /oauth/userinfo — endpoint risorsa (Bearer oat_*).
// Ritorna: { sub: <user external_id>, email, locationId }
// ─────────────────────────────────────────────────────────────────────────
router.get("/oauth/userinfo", async (req, res) => {
  try {
    const authHeader = String(req.get("Authorization") || "");
    const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

    if (!rawToken) {
      return res.status(401).json({
        statusCode: 401,
        message: "Bearer token richiesto",
      });
    }

    const tokenInfo = await validateAccessToken(rawToken);
    if (!tokenInfo) {
      return res.status(401).json({
        statusCode: 401,
        message: "Token non valido, scaduto o revocato",
      });
    }

    res.json({
      sub: String(tokenInfo.userExternalId),
      email: tokenInfo.userEmail,
      locationId: String(tokenInfo.siteLocationId),
    });
  } catch (err) {
    logger.error(`GET /oauth/userinfo error: ${err.message}`);
    res.status(500).json({ statusCode: 500, message: "Errore interno" });
  }
});

export default router;
