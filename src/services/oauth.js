import crypto from "crypto";
import { query } from "../db.js";
import config from "../config.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 36 — OAuth Google (flusso Authorization Code).
//
// Gestisce app OAuth (credenziali per sito) e connessioni (token ottenuti
// dopo il consenso dell'utente) per Gmail/Calendar/Drive. Le chiamate reali
// a Google avvengono SOLO con credenziali configurate; senza credenziali
// (o senza rete) il servizio ritorna {error} con messaggio chiaro — mai un
// crash. Nessuna dipendenza nuova: usa fetch nativo + AbortSignal.timeout.
//
// State del flusso: `${siteId}:${appId}:${hex random}` — il callback
// pubblico lo decodifica per ritrovare l'app senza parametri extra.
// ─────────────────────────────────────────────────────────────────────────

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];
const MAX_SCOPES = 20;
const REQUEST_TIMEOUT_MS = 15000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Sanitizza i campi di un'app OAuth. I campi mancanti restano undefined così
// il chiamante (create/update) decide il fallback (default o valore attuale).
function sanitizeAppData(data = {}) {
  const provider = String(data.provider ?? "google").trim().slice(0, 20) || "google";
  const clientId = String(data.client_id ?? "").slice(0, 255);
  const clientSecret = String(data.client_secret ?? "").slice(0, 255);
  const redirectUri = String(data.redirect_uri ?? "").trim().slice(0, 500);
  if (redirectUri && !/^https?:\/\//i.test(redirectUri)) {
    throw httpError(400, "redirect_uri deve essere http/https");
  }
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.map((s) => String(s).trim().slice(0, 500)).filter(Boolean).slice(0, MAX_SCOPES)
    : null;
  const enabled = data.enabled === undefined ? undefined : !!data.enabled;
  return { provider, clientId, clientSecret, redirectUri, scopes, enabled };
}

function pickScopes(appScopes, fallback = DEFAULT_SCOPES) {
  return Array.isArray(appScopes) && appScopes.length ? appScopes : fallback;
}

// Decodifica l'email dal payload dell'id_token JWT restituito da Google
// (header.payload.signature, payload base64url). Mai lanciata.
function extractEmailFromIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") return "";
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return "";
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    return String(json.email || "").slice(0, 255);
  } catch {
    return "";
  }
}

// ── CRUD app ────────────────────────────────────────────────────────────

export async function listApps(siteId) {
  const result = await query(
    "SELECT * FROM oauth_apps WHERE site_id = $1 ORDER BY id",
    [siteId]
  );
  return result.rows;
}

export async function createApp(siteId, data = {}) {
  const clean = sanitizeAppData(data);
  const result = await query(
    `INSERT INTO oauth_apps (site_id, provider, client_id, client_secret, redirect_uri, scopes, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      siteId,
      clean.provider,
      clean.clientId,
      clean.clientSecret,
      clean.redirectUri,
      JSON.stringify(pickScopes(clean.scopes)),
      clean.enabled === undefined ? true : clean.enabled,
    ]
  );
  return result.rows[0];
}

export async function updateApp(siteId, id, data = {}) {
  const current = (await query(
    "SELECT * FROM oauth_apps WHERE id = $1 AND site_id = $2",
    [id, siteId]
  )).rows[0];
  if (!current) throw httpError(404, "App OAuth non trovata");
  const clean = sanitizeAppData(data);
  const result = await query(
    `UPDATE oauth_apps
     SET provider = $1, client_id = $2, client_secret = $3, redirect_uri = $4,
         scopes = $5, enabled = $6, updated_at = NOW()
     WHERE id = $7 AND site_id = $8 RETURNING *`,
    [
      clean.provider,
      clean.clientId,
      clean.clientSecret,
      clean.redirectUri,
      JSON.stringify(pickScopes(clean.scopes, pickScopes(current.scopes))),
      clean.enabled === undefined ? current.enabled : clean.enabled,
      id,
      siteId,
    ]
  );
  return result.rows[0];
}

export async function deleteApp(siteId, id) {
  const result = await query(
    "DELETE FROM oauth_apps WHERE id = $1 AND site_id = $2 RETURNING id",
    [id, siteId]
  );
  if (!result.rows[0]) throw httpError(404, "App OAuth non trovata");
  return { deleted: true, id: result.rows[0].id };
}

// ── State firmato (difesa in profondità contro login CSRF) ─────────────
//
// Lo state emesso dal flusso è `${siteId}:${appId}:${hex random}:${hmac}`.
// L'HMAC (HMAC-SHA256 con JWT_SECRET) rende impossibile forgiare uno state
// valido conoscendo solo siteId+appId: il callback verifica la firma con
// timingSafeEqual prima di usare lo state. Formato a 4 parti separate da ":",
// la firma è SEMPRE l'ultima parte (lastIndexOf) quindi il raw può contenere
// ":" senza ambiguità.

function signState(raw) {
  const key = config.jwtSecret || "dev-secret";
  return crypto.createHmac("sha256", key).update(String(raw)).digest("hex");
}

export function buildState(siteId, appId) {
  const raw = `${siteId}:${appId}:${crypto.randomBytes(8).toString("hex")}`;
  return `${raw}:${signState(raw)}`;
}

// Verifica struttura + firma HMAC. Ritorna {siteId, appId} o null (state
// malformato, non firmato o con firma non valida → mai fidarsi).
export function verifyState(state) {
  const s = String(state || "");
  const idx = s.lastIndexOf(":");
  if (idx <= 0) return null;
  const raw = s.slice(0, idx);
  const provided = s.slice(idx + 1);
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const siteId = parseInt(parts[0], 10);
  const appId = parseInt(parts[1], 10);
  if (!Number.isInteger(siteId) || siteId < 1) return null;
  if (!Number.isInteger(appId) || appId < 1) return null;
  const expected = signState(raw);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? { siteId, appId } : null;
}

// ── Flusso Authorization Code ───────────────────────────────────────────

// Costruisce l'URL di autorizzazione Google. Se l'app non esiste/è disattiva
// → {error} (mai throw): la route decide lo status HTTP.
export async function getAuthUrl(siteId, { app_id, scope, state } = {}) {
  const appId = parseInt(app_id, 10);
  if (!Number.isInteger(appId) || appId < 1) return { error: "App OAuth non configurata" };
  const app = (await query(
    "SELECT * FROM oauth_apps WHERE id = $1 AND site_id = $2 AND enabled = true",
    [appId, siteId]
  )).rows[0];
  if (!app) return { error: "App OAuth non configurata" };
  if (!app.client_id || !app.redirect_uri) return { error: "App OAuth non configurata" };

  const scopes = Array.isArray(scope) && scope.length
    ? scope.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_SCOPES)
    : pickScopes(app.scopes);

  // state = `${siteId}:${appId}:${hex random}:${hmac}` così il callback
  // pubblico può ritrovare l'app E verificare che lo state sia stato emesso
  // da noi (firma HMAC, anti login-CSRF). Se il chiamante passa uno state
  // proprio, viene comunque firmato: un state non firmato verrebbe rifiutato.
  const finalState = state ? `${state}:${signState(state)}` : buildState(siteId, appId);

  const params = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: app.redirect_uri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: finalState,
  });
  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state: finalState };
}

// Scambia il codice di autorizzazione con i token. Il fetch verso Google può
// fallire (nessuna rete, credenziali finte, timeout): tutto viene catturato e
// ritornato come {error} — mai un'eccezione che diventa 500.
export async function exchangeCode(siteId, { app_id, code, state } = {}) {
  const appId = parseInt(app_id, 10);
  if (!Number.isInteger(appId) || appId < 1) return { error: "App OAuth non configurata" };
  const app = (await query(
    "SELECT * FROM oauth_apps WHERE id = $1 AND site_id = $2",
    [appId, siteId]
  )).rows[0];
  if (!app) return { error: "App OAuth non configurata" };
  if (!app.client_id || !app.client_secret) return { error: "App OAuth non configurata" };
  if (!code) return { error: "Codice di autorizzazione mancante" };

  const body = new URLSearchParams({
    client_id: app.client_id,
    client_secret: app.client_secret,
    code: String(code),
    redirect_uri: app.redirect_uri,
    grant_type: "authorization_code",
  });

  let response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `Scambio codice fallito: ${err.message}` };
  }
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) msg += `: ${text.slice(0, 200)}`;
    } catch { /* corpo illeggibile: usa solo lo status */ }
    return { error: `Scambio codice fallito: ${msg}` };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { error: "Scambio codice fallito: risposta non valida" };
  }

  const accountEmail = extractEmailFromIdToken(data.id_token);
  const expiresAt = new Date(Date.now() + (parseInt(data.expires_in, 10) || 3600) * 1000);
  const scopeList = pickScopes(app.scopes);

  const existing = (await query(
    "SELECT * FROM oauth_connections WHERE site_id = $1 AND app_id = $2",
    [siteId, appId]
  )).rows[0];

  let connection;
  if (existing) {
    const upd = await query(
      `UPDATE oauth_connections
       SET access_token = $1, refresh_token = $2, token_expires_at = $3,
           account_email = $4, scope = $5, active = true, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [
        String(data.access_token ?? ""),
        String(data.refresh_token ?? existing.refresh_token ?? ""),
        expiresAt,
        accountEmail,
        JSON.stringify(scopeList),
        existing.id,
      ]
    );
    connection = upd.rows[0];
  } else {
    const ins = await query(
      `INSERT INTO oauth_connections
         (site_id, app_id, provider, account_email, access_token, refresh_token,
          token_expires_at, scope, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING *`,
      [
        siteId,
        appId,
        app.provider || "google",
        accountEmail,
        String(data.access_token ?? ""),
        String(data.refresh_token ?? ""),
        expiresAt,
        JSON.stringify(scopeList),
      ]
    );
    connection = ins.rows[0];
  }

  return { connection, account_email: accountEmail };
}

// Rinnova l'access_token con il refresh_token salvato. Stessa filosofia:
// ogni fallimento di rete/API diventa {error}, mai eccezione.
export async function refreshToken(siteId, connectionId) {
  const connId = parseInt(connectionId, 10);
  if (!Number.isInteger(connId) || connId < 1) return { error: "Connessione non trovata" };
  const conn = (await query(
    `SELECT c.*, a.client_id, a.client_secret
     FROM oauth_connections c
     LEFT JOIN oauth_apps a ON a.id = c.app_id
     WHERE c.id = $1 AND c.site_id = $2`,
    [connId, siteId]
  )).rows[0];
  if (!conn) return { error: "Connessione non trovata" };
  if (!conn.refresh_token) return { error: "Nessun refresh token" };
  if (!conn.client_id || !conn.client_secret) return { error: "App OAuth non configurata" };

  const body = new URLSearchParams({
    client_id: conn.client_id,
    client_secret: conn.client_secret,
    refresh_token: conn.refresh_token,
    grant_type: "refresh_token",
  });

  let response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `Refresh fallito: ${err.message}` };
  }
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) msg += `: ${text.slice(0, 200)}`;
    } catch { /* solo status */ }
    return { error: `Refresh fallito: ${msg}` };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { error: "Refresh fallito: risposta non valida" };
  }

  const expiresAt = new Date(Date.now() + (parseInt(data.expires_in, 10) || 3600) * 1000);
  const upd = await query(
    `UPDATE oauth_connections
     SET access_token = $1, token_expires_at = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [String(data.access_token ?? ""), expiresAt, connId]
  );
  return { ok: true, connection: upd.rows[0] };
}

// ── Connessioni ─────────────────────────────────────────────────────────

export async function listConnections(siteId) {
  const result = await query(
    `SELECT c.*, a.client_id AS app_client_id, a.redirect_uri AS app_redirect_uri,
            a.scopes AS app_scopes, a.enabled AS app_enabled
     FROM oauth_connections c
     LEFT JOIN oauth_apps a ON a.id = c.app_id
     WHERE c.site_id = $1
     ORDER BY c.id`,
    [siteId]
  );
  return result.rows;
}

export async function disconnect(siteId, appId) {
  const appIdInt = parseInt(appId, 10);
  if (!Number.isInteger(appIdInt) || appIdInt < 1) return { ok: true, disconnected: false };
  const conn = (await query(
    "SELECT * FROM oauth_connections WHERE site_id = $1 AND app_id = $2",
    [siteId, appIdInt]
  )).rows[0];
  if (!conn) return { ok: true, disconnected: false };
  await query(
    "UPDATE oauth_connections SET active = false, updated_at = NOW() WHERE id = $1",
    [conn.id]
  );
  return { ok: true, disconnected: true };
}

export async function isConnected(siteId, appId) {
  const appIdInt = parseInt(appId, 10);
  if (!Number.isInteger(appIdInt) || appIdInt < 1) return { connected: false, connection: null };
  const conn = (await query(
    "SELECT * FROM oauth_connections WHERE site_id = $1 AND app_id = $2",
    [siteId, appIdInt]
  )).rows[0];
  if (!conn || !conn.active) return { connected: false, connection: conn || null };
  const expired = conn.token_expires_at
    ? new Date(conn.token_expires_at).getTime() <= Date.now()
    : true;
  return { connected: !expired, connection: conn };
}
