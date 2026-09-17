import jwt from "jsonwebtoken";
import config from "../config.js";
import { query } from "../db.js";
import { isApiTokenFormat, verifyApiToken } from "../services/api-tokens.js";

// ─────────────────────────────────────────────────────────────────────────
// Gate scope per gli API token (agtok_): applicato QUI, in un punto solo,
// così OGNI endpoint attuale e futuro sotto /api/* eredita il controllo
// senza doverlo ricordare route-per-route. Un token senza scope "write"
// non può eseguire metodi di scrittura (POST/PUT/PATCH/DELETE); le sessioni
// browser/JWT non sono toccate (il loro perimetro è ruolo/RBAC).
//
// Eccezioni esplicite:
// - /api/auth/*  — flusso di login/logout, nessuna mutazione dati del CMS.
// - /api/mcp     — transport MCP: tutto viaggia su POST (anche le letture).
//                  I tool di scrittura vengono comunque bloccati dal gate
//                  quando makeToolHandler ri-dispatcha internamente su
//                  /api/agent (stesso stack Express, stesso gate).
//
// Allowlist READ-ONLY_POST: endpoint POST semanticamente di LETTURA,
// censiti uno a uno sugli handler (nessun INSERT/UPDATE/side-effect):
//   pages/search            → ricerca testo pagine (SELECT)
//   pages/:id/validate      → validazione snippet/contenuto (SELECT)
//   channel-limits/check    → lettura contatori consumo (SELECT)
//   workflows/:id/test      → dry-run: elenco azioni che partirebbero (SELECT)
//   /api/call-verdict       → lettura verdetto chiamata esistente (SELECT)
//   satellites/:name/invoke → proxy tra satelliti: la natura (lettura/scrittura)
//                             dell'endpoint TARGET è verificata per-endpoint
//                             dentro services/satelliteProxy.js (scope della
//                             capability dichiarata), quindi qui passa anche
//                             un token read-only per invocare endpoint read.
//   /contacts/search, /contacts/search/duplicate, /opportunities/search,
//   /users/search (surface clone, root-level, vhost sites.api_domain) e gli
//   stessi tre sotto /v1/... (surface compatibile) → ricerca/lista (SELECT),
//   MAI /contacts/upsert né /opportunities/upsert (quelle scrivono davvero).
//   req.route non è ancora popolato quando questo gate gira (middleware
//   router-level, prima del matching della route specifica): i pattern qui
//   sono quindi path letterali, non parametrici.
// Scartati dal censimento perché SEMBRANO letture ma mutano/eseguono:
//   followup-check (esegue azioni), reply-suggestions/generate (INSERT+LLM),
//   segments/recount (muta segment_members), */test-send (invia email),
//   export-static* (scrive file), data-import, sandbox/run, runtime/process,
//   webhook-deliveries/run (invia verso destinazioni esterne).
// ─────────────────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const READ_ONLY_POST_ALLOWLIST = new Set([
  "/api/agent/pages/search",
  "/api/agent/sites/:siteId/pages/:pageId/validate",
  "/api/agent/sites/:siteId/channel-limits/check",
  "/api/agent/sites/:siteId/workflows/:workflowId/test",
  "/api/call-verdict",
  "/api/agent/satellites/:name/invoke",
  // Clone (root-level, vhost api_domain):
  "/contacts/search",
  "/contacts/search/duplicate",
  "/opportunities/search",
  "/users/search",
  // Compat API (/v1), stessi endpoint di ricerca:
  "/v1/contacts/search",
  "/v1/contacts/search/duplicate",
  "/v1/opportunities/search",
]);

function fullPathOf(req) {
  return (req.baseUrl || "") + req.path;
}

// Pattern della rotta matchata (se disponibile) per il confronto con
// l'allowlist: i :param restano simbolici, niente normalizzazione fragile
// dei segmenti numerici.
function routePatternOf(req) {
  return (req.baseUrl || "") + (req.route?.path ?? req.path);
}

export function apiTokenScopeGate(req, res) {
  if (!WRITE_METHODS.has(req.method)) return true;
  const path = fullPathOf(req);
  if (path === "/api/mcp" || path.startsWith("/api/auth/")) return true;

  const method = req.method;
  const pattern = routePatternOf(req);
  if (method === "POST" && READ_ONLY_POST_ALLOWLIST.has(pattern)) return true;

  const scopes = Array.isArray(req.user.scopes) ? req.user.scopes : [];
  if (scopes.includes("write")) return true;

  res.status(403).json({
    error: "token_scope_required",
    required_scope: "write",
    message: "Questo API token è in sola lettura: rigeneralo con i permessi di scrittura abilitati.",
  });
  return false;
}

export async function requireAuth(req, res, next) {
  const fromCookie = !!req.cookies?.token;
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  const token = req.cookies?.token || m?.[1];

  if (!token) {
    if (req.path.startsWith("/api")) {
      return res.status(401).json({ error: res.locals.t("api.auth.authRequired") });
    }
    return res.redirect("/login");
  }

  // Token API di lunga durata (n8n/automazioni non interattive): riga a sé
  // in api_tokens, revocabile singolarmente — non passa da jwt.verify né dal
  // controllo token_version (vedi services/api-tokens.js sul perché).
  if (isApiTokenFormat(token)) {
    let apiUser;
    try {
      apiUser = await verifyApiToken(token);
    } catch {
      // DB irraggiungibile: il token potrebbe essere valido — 503 come il
      // ramo JWT qui sotto, non 401 invalid_token.
      return res.status(503).json({ error: res.locals.t("api.common.serviceUnavailable") });
    }
    if (!apiUser) {
      return res.status(401).json({ error: res.locals.t("api.auth.invalidToken") });
    }
    req.user = apiUser;
    res.locals.user = apiUser;
    // Gate scope globale (vedi commento in testa): un punto solo per tutte
    // le surface /api/* attuali e future.
    if (!apiTokenScopeGate(req, res)) return undefined;
    return next();
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    if (req.path.startsWith("/api")) {
      return res.status(401).json({ error: res.locals.t("api.auth.invalidToken") });
    }
    if (fromCookie) res.clearCookie("token");
    return res.redirect("/login");
  }

  try {
    const result = await query("SELECT token_version, status FROM users WHERE id = $1", [decoded.sub]);
    const dbUser = result.rows[0];
    if (!dbUser || dbUser.status === "disabled" || dbUser.token_version !== decoded.token_version) {
      if (fromCookie) res.clearCookie("token");
      if (req.path.startsWith("/api")) return res.status(401).json({ error: res.locals.t("api.auth.invalidSession") });
      return res.redirect("/login");
    }
  } catch {
    if (req.path.startsWith("/api")) {
      return res.status(503).json({ error: res.locals.t("api.common.serviceUnavailable") });
    }
    return res.redirect("/login");
  }

  req.user = decoded;
  res.locals.user = decoded;
  next();
}
