import crypto from "crypto";
import { query } from "../db.js";

const CODE_PREFIX = "code_";
const ACCESS_PREFIX = "oat_";
const REFRESH_PREFIX = "ort_";
const AUTHORIZATION_CODE_EXPIRY_MINUTES = 10;
const ACCESS_TOKEN_EXPIRY_SECONDS = 3600;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function generateRandomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// Registra una nuova app OAuth per un tenant (site).
export async function registerOAuthApp(siteId, name, redirectUris, scopes) {
  const clientId = generateRandomHex(16);
  const clientSecret = generateRandomHex(24);
  const secretHash = sha256(clientSecret);

  const result = await query(
    `INSERT INTO oauth_provider_apps (site_id, client_id, client_secret_hash, name, redirect_uris, scopes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, external_id, client_id, created_at`,
    [siteId, clientId, secretHash, name, JSON.stringify(redirectUris), JSON.stringify(scopes)]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    app: {
      id: String(row.external_id),
      clientId: row.client_id,
      clientSecret: clientSecret, // ritornato UNA SOLA VOLTA
      redirectUris,
      scopes,
    },
  };
}

// Recupera app per client_id (per validare authorize/token).
export async function findAppByClientId(clientId) {
  const result = await query(
    // NB: client_secret_hash serve alla verifica del secret in /oauth/token
    "SELECT id, external_id, site_id, name, client_secret_hash, redirect_uris, scopes, active FROM oauth_provider_apps WHERE client_id = $1",
    [clientId]
  );
  return result.rows[0] || null;
}

// Genera un authorization code e lo salva.
export async function createAuthorizationCode(appId, siteId, userId, redirectUri, scopes) {
  const raw = CODE_PREFIX + generateRandomHex(16);
  const codeHash = sha256(raw);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_EXPIRY_MINUTES * 60000);

  const result = await query(
    `INSERT INTO oauth_provider_codes (code_hash, app_id, site_id, user_id, redirect_uri, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [codeHash, appId, siteId, userId, redirectUri, scopes, expiresAt]
  );

  return raw;
}

// Valida e "usa" un authorization code (esattamente una volta).
export async function consumeAuthorizationCode(codeRaw, clientId, redirectUri) {
  const codeHash = sha256(codeRaw);

  const result = await query(
    `SELECT id, app_id, site_id, user_id, scope, used_at, expires_at
     FROM oauth_provider_codes
     WHERE code_hash = $1`,
    [codeHash]
  );

  const code = result.rows[0];
  if (!code) return { error: "invalid_grant" };

  if (code.used_at) return { error: "invalid_grant" }; // già usato
  if (new Date() > code.expires_at) return { error: "invalid_grant" }; // scaduto

  // Valida il client_id e il redirect_uri
  const app = await findAppByClientId(clientId);
  if (!app || app.id !== code.app_id) return { error: "invalid_client" };

  const uris = Array.isArray(app.redirect_uris) ? app.redirect_uris : [];
  if (!uris.includes(redirectUri)) return { error: "invalid_grant" };

  // Marca come usato
  await query(
    "UPDATE oauth_provider_codes SET used_at = NOW() WHERE id = $1",
    [code.id]
  );

  return {
    appId: code.app_id,
    siteId: code.site_id,
    userId: code.user_id,
    scopes: code.scope,
  };
}

// Crea una coppia access_token + refresh_token.
export async function createTokens(appId, siteId, userId, scopes) {
  const accessRaw = ACCESS_PREFIX + generateRandomHex(24);
  const refreshRaw = REFRESH_PREFIX + generateRandomHex(24);
  const accessHash = sha256(accessRaw);
  const refreshHash = sha256(refreshRaw);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_EXPIRY_SECONDS * 1000);

  const result = await query(
    `INSERT INTO oauth_provider_tokens (app_id, site_id, user_id, access_hash, refresh_hash, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, external_id, created_at`,
    [appId, siteId, userId, accessHash, refreshHash, scopes, expiresAt]
  );

  return {
    accessToken: accessRaw,
    refreshToken: refreshRaw,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    tokenType: "Bearer",
    scope: scopes,
  };
}

// Valida un access_token e ritorna user/site info.
export async function validateAccessToken(accessRaw) {
  const accessHash = sha256(accessRaw);

  const result = await query(
    `SELECT id, app_id, site_id, user_id, scope, revoked_at, expires_at
     FROM oauth_provider_tokens
     WHERE access_hash = $1`,
    [accessHash]
  );

  const token = result.rows[0];
  if (!token) return null;
  if (token.revoked_at) return null;
  if (new Date() > token.expires_at) return null;

  const userResult = await query(
    "SELECT id, external_id, email FROM users WHERE id = $1",
    [token.user_id]
  );
  const user = userResult.rows[0];

  const siteResult = await query(
    "SELECT id, external_id, location_external_id FROM sites WHERE id = $1",
    [token.site_id]
  );
  const site = siteResult.rows[0];

  return {
    tokenId: token.id,
    userId: token.user_id,
    userEmail: user?.email,
    userExternalId: user?.external_id,
    siteId: token.site_id,
    siteLocationId: site?.location_external_id || site?.external_id,
    scope: token.scope,
  };
}

// Scambia un refresh_token per una nuova coppia (rotazione).
export async function rotateRefreshToken(refreshRaw) {
  const refreshHash = sha256(refreshRaw);

  const result = await query(
    `SELECT id, app_id, site_id, user_id, scope, revoked_at, expires_at
     FROM oauth_provider_tokens
     WHERE refresh_hash = $1`,
    [refreshHash]
  );

  const token = result.rows[0];
  if (!token) return { error: "invalid_grant" };
  if (token.revoked_at) return { error: "invalid_grant" };
  if (new Date() > token.expires_at) return { error: "invalid_grant" };

  // Revoca il vecchio token
  await query("UPDATE oauth_provider_tokens SET revoked_at = NOW() WHERE id = $1", [token.id]);

  // Crea nuova coppia
  return createTokens(token.app_id, token.site_id, token.user_id, token.scope);
}

// Revoca un access o refresh token.
export async function revokeToken(tokenRaw) {
  const accessHash = sha256(tokenRaw);
  const refreshHash = sha256(tokenRaw);

  await query(
    `UPDATE oauth_provider_tokens
     SET revoked_at = NOW()
     WHERE access_hash = $1 OR refresh_hash = $2`,
    [accessHash, refreshHash]
  );

  return true;
}
