import crypto from "node:crypto";
import { query } from "../db.js";
import config from "../config.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { safeFetch } from "./ssrf.js";
import { createChallenge, getChallenge, consumeChallenge } from "./mfa.js";
import { validateRedirectUri } from "./satellites.js";
import { auditLog } from "./audit.js";
import { logger } from "./logger.js";

const ALLOW_PRIVATE = () => process.env.OIDC_ALLOW_PRIVATE === "1";   // SOLO test: letto qui e da nessun'altra parte
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,58}$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const ALGS = ["RS256", "ES256", "PS256"];
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function err(code, extra = {}) { const e = new Error(code); e.code = code; return Object.assign(e, extra); }
let joseP = null;
const jose = () => (joseP ||= import("jose"));
export const redirectUri = () => String(config.magicLinkBaseUrl).replace(/\/$/, "") + "/auth/oidc/callback";
const okScheme = (u) => u.protocol === "https:" || (u.protocol === "http:" && ALLOW_PRIVATE());
const parseUrl = (s) => { try { return new URL(s); } catch { return null; } };

// ---------- provider CRUD ----------
function clean(data, existing = null) {
  const bad = (field) => { throw err("INVALID_PROVIDER", { field }); };
  const pick = (k) => (data[k] !== undefined ? data[k] : existing?.[k]);
  const o = {};
  const slug = String(pick("slug") ?? ""); if (!SLUG_RE.test(slug)) bad("slug"); o.slug = slug;
  const name = String(pick("name") ?? "").trim(); if (name.length < 1 || name.length > 100) bad("name"); o.name = name;
  const issuer = String(pick("issuer") ?? "").trim().replace(/\/+$/, "");
  const u = parseUrl(issuer);
  if (!u || !okScheme(u) || u.search || u.hash || u.username || u.password) bad("issuer");
  o.issuer = issuer;
  const clientId = String(pick("client_id") ?? "").trim(); if (!clientId || clientId.length > 500) bad("client_id"); o.client_id = clientId;
  const scopes = String(pick("scopes") ?? "openid email profile").trim().split(/\s+/).join(" ");
  if (!scopes.split(" ").includes("openid") || scopes.length > 300 || !/^[\x21-\x7e ]+$/.test(scopes)) bad("scopes");
  o.scopes = scopes;
  const dom = pick("allowed_email_domains") ?? [];
  if (!Array.isArray(dom) || !dom.every((d) => DOMAIN_RE.test(String(d).toLowerCase()))) bad("allowed_email_domains");
  o.allowed_email_domains = dom.map((d) => String(d).toLowerCase());
  o.trust_idp_mfa = pick("trust_idp_mfa") === true;
  o.enabled = pick("enabled") !== false;
  const sid = pick("site_id");
  o.site_id = sid === null || sid === undefined || sid === "" ? null : Number(sid);
  if (o.site_id !== null && (!Number.isInteger(o.site_id) || o.site_id < 1)) bad("site_id");
  return o;
}
export async function listProviders({ siteId, includeGlobal = true, onlyEnabled = false } = {}) {
  const where = []; const params = [];
  if (siteId !== undefined) { params.push(siteId); where.push(includeGlobal ? `(site_id = $${params.length} OR site_id IS NULL)` : `site_id = $${params.length}`); }
  if (onlyEnabled) where.push("enabled = true");
  return (await query(`SELECT * FROM oidc_providers ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`, params)).rows;
}
export async function getProvider(id) {
  const n = Number(id); if (!Number.isInteger(n) || n < 1) return null;
  return (await query("SELECT * FROM oidc_providers WHERE id = $1", [n])).rows[0] || null;
}
export const publicProvider = (p) => ({ id: p.id, site_id: p.site_id, slug: p.slug, name: p.name, issuer: p.issuer, client_id: p.client_id, scopes: p.scopes,
  allowed_email_domains: p.allowed_email_domains, trust_idp_mfa: p.trust_idp_mfa, enabled: p.enabled, has_secret: !!p.client_secret_enc, created_at: p.created_at, updated_at: p.updated_at });
export async function createProvider(data) {
  const o = clean(data || {});
  const enc = data.client_secret ? encryptSecret(String(data.client_secret)) : "";
  try {
    return (await query(
      `INSERT INTO oidc_providers (site_id, slug, name, issuer, client_id, client_secret_enc, scopes, allowed_email_domains, trust_idp_mfa, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [o.site_id, o.slug, o.name, o.issuer, o.client_id, enc, o.scopes, o.allowed_email_domains, o.trust_idp_mfa, o.enabled])).rows[0];
  } catch (e) { if (e.code === "23505") throw err("INVALID_PROVIDER", { field: "slug" }); throw e; }
}
export async function updateProvider(id, data) {
  const cur = await getProvider(id); if (!cur) throw err("NOT_FOUND");
  const o = clean(data || {}, cur);
  const enc = data.client_secret ? encryptSecret(String(data.client_secret)) : cur.client_secret_enc;
  try {
    return (await query(
      `UPDATE oidc_providers SET site_id=$2, slug=$3, name=$4, issuer=$5, client_id=$6, client_secret_enc=$7, scopes=$8, allowed_email_domains=$9, trust_idp_mfa=$10, enabled=$11, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [cur.id, o.site_id, o.slug, o.name, o.issuer, o.client_id, enc, o.scopes, o.allowed_email_domains, o.trust_idp_mfa, o.enabled])).rows[0];
  } catch (e) { if (e.code === "23505") throw err("INVALID_PROVIDER", { field: "slug" }); throw e; }
}
export async function deleteProvider(id) { await query("DELETE FROM oidc_providers WHERE id = $1", [id]); }

// ---------- discovery + JWKS (SSRF-safe, cache 10 min) ----------
const discCache = new Map();
export async function discover(issuer) {
  const hit = discCache.get(issuer);
  if (hit && Date.now() - hit.at < 600000) return hit.doc;
  const res = await safeFetch(issuer + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" }, allowPrivate: ALLOW_PRIVATE() }, 2);
  if (res.status !== 200) throw err("DISCOVERY_FAILED");
  const text = await res.text();
  if (text.length > 200000) throw err("DISCOVERY_FAILED");
  let doc; try { doc = JSON.parse(text); } catch { throw err("DISCOVERY_FAILED"); }
  if (doc.issuer !== issuer) throw err("ISSUER_MISMATCH");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const u = typeof doc[k] === "string" ? parseUrl(doc[k]) : null;
    if (!u || !okScheme(u)) throw err("DISCOVERY_FAILED");
  }
  discCache.set(issuer, { doc, at: Date.now() });
  return doc;
}
const jwksCache = new Map();
async function getJwks(doc, force = false) {
  const hit = jwksCache.get(doc.jwks_uri);
  if (!force && hit && Date.now() - hit.at < 600000) return hit.jwks;
  const res = await safeFetch(doc.jwks_uri, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" }, allowPrivate: ALLOW_PRIVATE() }, 2);
  if (res.status !== 200) throw err("JWKS_FAILED");
  const text = await res.text();
  if (text.length > 200000) throw err("JWKS_FAILED");
  const jwks = JSON.parse(text);
  if (!jwks || !Array.isArray(jwks.keys)) throw err("JWKS_FAILED");
  jwksCache.set(doc.jwks_uri, { jwks, at: Date.now() });
  return jwks;
}

// ---------- flusso authorization code + PKCE S256 + state + nonce ----------
export async function buildAuthRequest(provider, { redirect_uri = "" } = {}) {
  const d = await discover(provider.issuer);
  const nonce = b64u(crypto.randomBytes(24));
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const post_login = (await validateRedirectUri(redirect_uri)) || "";
  const state = await createChallenge(null, "oidc", { nonce, verifier, provider_id: provider.id, post_login }, 600);
  const u = new URL(d.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: provider.client_id, redirect_uri: redirectUri(), scope: provider.scopes, state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
  return { url: u.toString(), state };
}

export async function completeLogin(provider, { code, state, browserState }) {
  if (!state || !browserState || state !== browserState) throw err("STATE_MISMATCH");   // il state e' legato al browser dal cookie httpOnly
  const ch = await getChallenge(state, "oidc");
  if (!ch || ch.data?.provider_id !== provider.id) throw err("STATE_MISMATCH");
  if (!(await consumeChallenge(state))) throw err("STATE_MISMATCH");                     // monouso
  const d = await discover(provider.issuer);
  const secret = provider.client_secret_enc ? decryptSecret(provider.client_secret_enc) : "";
  const form = new URLSearchParams({ grant_type: "authorization_code", code: String(code ?? ""), redirect_uri: redirectUri(), client_id: provider.client_id, code_verifier: ch.data.verifier });
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const methods = d.token_endpoint_auth_methods_supported;
  if (secret) {
    if (Array.isArray(methods) && !methods.includes("client_secret_post") && methods.includes("client_secret_basic")) {
      headers.Authorization = "Basic " + Buffer.from(`${encodeURIComponent(provider.client_id)}:${encodeURIComponent(secret)}`).toString("base64");
    } else form.set("client_secret", secret);
  }
  // maxRedirects = 0: il client secret non segue mai un redirect
  const res = await safeFetch(d.token_endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(10000), allowPrivate: ALLOW_PRIVATE() }, 0);
  const text = await res.text();
  if (res.status !== 200 || text.length > 200000) throw err("TOKEN_FAILED");
  let tok; try { tok = JSON.parse(text); } catch { throw err("TOKEN_FAILED"); }
  if (typeof tok.id_token !== "string") throw err("TOKEN_FAILED");
  const { jwtVerify, createLocalJWKSet, errors } = await jose();
  const opts = { issuer: provider.issuer, audience: provider.client_id, algorithms: ALGS, clockTolerance: 60, requiredClaims: ["exp", "sub"] };
  let payload;
  try { ({ payload } = await jwtVerify(tok.id_token, createLocalJWKSet(await getJwks(d)), opts)); }
  catch (e) {
    if (e instanceof errors.JWKSNoMatchingKey) ({ payload } = await jwtVerify(tok.id_token, createLocalJWKSet(await getJwks(d, true)), opts));
    else throw e;
  }
  if (payload.nonce !== ch.data.nonce) throw err("NONCE_MISMATCH");
  if (payload.email_verified !== true) throw err("EMAIL_NOT_VERIFIED");
  const email = String(payload.email || "").trim().toLowerCase();
  if (!email.includes("@")) throw err("EMAIL_NOT_VERIFIED");
  if (provider.allowed_email_domains?.length && !provider.allowed_email_domains.includes(email.split("@").pop())) throw err("DOMAIN_NOT_ALLOWED");
  const user = (await query("SELECT id, email, name, role, site_id, status, token_version FROM users WHERE lower(email) = $1 ORDER BY id LIMIT 1", [email])).rows[0];
  if (!user) throw err("NO_LOCAL_USER");                                                  // MAI creare utenti
  if (user.status === "disabled") throw err("USER_DISABLED");
  if (provider.site_id !== null && (user.site_id !== provider.site_id || user.role === "superadmin")) throw err("SITE_MISMATCH");
  await auditLog({ userId: user.id, siteId: user.site_id ?? null, entityType: "user", entityId: user.id, action: "sso_login", newData: { provider: provider.slug }, ipAddress: null });
  return { user, provider, post_login: ch.data.post_login || "" };
}

const PUBLIC_CODES = new Set(["STATE_MISMATCH", "NONCE_MISMATCH", "EMAIL_NOT_VERIFIED", "DOMAIN_NOT_ALLOWED", "NO_LOCAL_USER", "USER_DISABLED", "SITE_MISMATCH"]);
export function mapOidcError(e) {
  logger.warn(`oidc: ${e?.code || e?.name || "error"}: ${String(e?.message || "").slice(0, 200)}`);   // mai token/secret nei log
  return PUBLIC_CODES.has(e?.code) ? e.code.toLowerCase() : "oidc_failed";
}
