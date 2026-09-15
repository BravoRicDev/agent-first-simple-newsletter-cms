import { decryptSecret } from "./crypto.js";
import { auditLog } from "./audit.js";
import {
  getSatelliteForProxy, findEnabledSatelliteByUserId,
} from "./satellites.js";

// ─────────────────────────────────────────────────────────────────────────
// Proxy sincrono tra satelliti (F1): il CMS inoltra la chiamata del
// satellite A verso l'endpoint DICHIARATO dal satellite B, sulla rete
// Docker interna. Il chiamante non conosce mai base_internal né il token
// M2M del target: tutto vive nel registro sso_satellites.
//
// Sicurezza:
// - solo endpoint presenti in capabilities (whitelist, match method+path
//   con supporto segmenti :param);
// - endpoint con scope "write" richiedono un agtok_ con scope write
//   (le sessioni browser passano: il loro perimetro è RBAC, come per
//   requireTokenWrite);
// - path sanificato: niente "..", backslash o URL assoluto che potrebbe
//   sovrascrivere base_internal;
// - NOTA: services/ssrf.js NON viene applicato alle uscite del proxy —
//   blocca i range privati che sono esattamente la rete interna Docker
//   a cui il proxy deve arrivare; resta per gli input pubblici.
//   base_internal è configurabile solo da superadmin.
//
// Errori come ProxyError(status, code): 404 satellite_not_found,
// 422 invalid_path / endpoint_not_declared, 403 token_scope_required,
// 501 satellite_not_reachable (config mancante), 502 bad_gateway (rete).
// Ogni invocazione (felice o meno) scrive un audit log.
// ─────────────────────────────────────────────────────────────────────────

export class ProxyError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const TIMEOUT_MS = 8000;
const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Path relativo alla base_internal: sempre con "/" iniziale, senza ".."
// né "\" né "#" (il fragment non ha senso server-side). La querystring
// viene conservata e inoltrata al target.
export function normalizeProxyPath(raw) {
  let p = String(raw || "").trim();
  if (!p) return null;
  if (p.includes("..") || p.includes("\\") || p.includes("#")) return null;
  const [pathPart, queryPart] = p.split("?", 2);
  if (!pathPart.startsWith("/")) p = "/" + pathPart;
  else p = pathPart;
  if (queryPart !== undefined) p += "?" + queryPart;
  return p;
}

// Match method + path contro le capability dichiarate. I segmenti che
// iniziano con ":" sono parametri (matchano qualunque valore non vuoto).
export function matchCapability(capabilities, method, path) {
  const m = String(method).toUpperCase();
  const cleanPath = path.split("?")[0];
  const segs = cleanPath.split("/").filter((s) => s !== "");
  for (const cap of capabilities || []) {
    if (!cap || String(cap.method).toUpperCase() !== m) continue;
    const capSegs = String(cap.path).split("/").filter((s) => s !== "");
    if (capSegs.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < capSegs.length; i++) {
      if (capSegs[i].startsWith(":")) {
        if (!segs[i]) { ok = false; break; }
      } else if (capSegs[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return cap;
  }
  return null;
}

async function auditInvoke({ callerName, target, method, path, status, detail }) {
  await auditLog({
    userId: null, siteId: null,
    entityType: "satellite_proxy",
    entityId: target.id, // colonna integer: il nome va in new_data
    action: "invoke",
    newData: { caller: callerName, target: target.name, method, path, status, ...(detail ? { detail } : {}) },
  }).catch(() => {});
}

// Invoca un endpoint dichiarato di un satellite target.
//   caller:     req.user del chiamante ({ sub, scopes, api_token, role })
//   targetName: nome del satellite target (parametro di route)
//   method/path/data: come da contratto POST /invoke
// Ritorna { status, body }.
export async function invokeSatellite({ caller, targetName, method = "GET", path, data }) {
  const m = String(method).toUpperCase();
  if (!VALID_METHODS.has(m)) throw new ProxyError(400, "invalid_method");

  const target = await getSatelliteForProxy(targetName);
  if (!target) throw new ProxyError(404, "satellite_not_found");

  const normPath = normalizeProxyPath(path);
  if (!normPath) throw new ProxyError(422, "invalid_path");

  const cap = matchCapability(target.capabilities, m, normPath);
  if (!cap) throw new ProxyError(422, "endpoint_not_declared");

  // Scope: gli endpoint write del target richiedono un token con write.
  // Le sessioni browser (senza api_token) non sono filtrate sugli scope —
  // coerente con middleware/scopes.js.
  const isTokenCaller = !!caller?.api_token;
  const scopes = Array.isArray(caller?.scopes) ? caller.scopes : [];
  if (cap.scope === "write" && isTokenCaller && !scopes.includes("write")) {
    throw new ProxyError(403, "token_scope_required");
  }

  if (!target.base_internal) throw new ProxyError(501, "satellite_not_reachable");

  let token;
  try {
    token = decryptSecret(target.agent_token_enc);
  } catch {
    token = null;
  }
  if (!target.agent_token_enc || !token) {
    // Config incompleta: senza token M2M il target non è invocabile.
    throw new ProxyError(501, "satellite_not_reachable");
  }

  const callerSat = await findEnabledSatelliteByUserId(caller?.sub);
  const callerName = callerSat ? callerSat.name : `user:${caller?.sub ?? "?"}`;

  let url;
  try {
    url = new URL(normPath, target.base_internal.replace(/\/+$/, "") + "/");
  } catch {
    throw new ProxyError(501, "satellite_not_reachable");
  }

  const headers = {
    "X-Satellite-Caller": callerName.slice(0, 200),
    Authorization: `Bearer ${token}`,
  };
  const init = { method: m, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (m !== "GET" && data !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(data);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const detail = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network_error";
    await auditInvoke({ callerName, target, method: m, path: normPath, status: 502, detail });
    throw new ProxyError(502, "bad_gateway", { detail });
  }

  let body;
  const text = await res.text().catch(() => "");
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  await auditInvoke({ callerName, target, method: m, path: normPath, status: res.status });
  return { status: res.status, body };
}
