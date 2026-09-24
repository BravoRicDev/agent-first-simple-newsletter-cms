import crypto from "crypto";
import { query } from "../db.js";

const TOKEN_PREFIX = "agtok_";

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

const VALID_SCOPES = new Set(["read", "write"]);

// Normalizza l'array scopes richiesto: case-insensitive, dedup, scarta
// valori sconosciuti; mai vuoto (fallback a sola lettura, mai a "nessuno
// scope" che romperebbe qualunque endpoint in lettura).
function normalizeScopes(raw) {
  const out = new Set();
  for (const s of (Array.isArray(raw) ? raw : [])) {
    const v = String(s).toLowerCase();
    if (VALID_SCOPES.has(v)) out.add(v);
  }
  if (out.size === 0) out.add("read");
  return [...out];
}

const VALID_ROLE_CAPS = new Set(["admin", "collaboratore"]);

// role_cap (db/136_api_token_role_cap.sql): tetto di ruolo opzionale, può
// solo abbassare mai elevare — valore fuori dall'allowlist = nessun tetto.
function normalizeRoleCap(raw) {
  const v = String(raw || "").toLowerCase();
  return VALID_ROLE_CAPS.has(v) ? v : null;
}

// Il valore in chiaro esiste solo qui, al momento della creazione — mai
// salvato, mai più recuperabile dopo (stesso modello dei PAT GitHub/Stripe).
//
// scopes: default sola lettura (vedi db/135_api_token_scopes.sql) — la
// scrittura è un opt-in esplicito per i token creati da qui in avanti.
export async function createApiToken(userId, name, expiresInDays, scopes = ["read"], roleCap = null) {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 14) + "…";
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000);
  const normalizedScopes = normalizeScopes(scopes);
  const normalizedRoleCap = normalizeRoleCap(roleCap);

  const result = await query(
    `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, expires_at, scopes, role_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [userId, name.slice(0, 255), hashToken(raw), prefix, expiresAt, normalizedScopes, normalizedRoleCap]
  );

  return { id: result.rows[0].id, token: raw, prefix, expiresAt, createdAt: result.rows[0].created_at, scopes: normalizedScopes, roleCap: normalizedRoleCap };
}

// Usata da requireAuth per i token che iniziano con TOKEN_PREFIX, al posto
// della verifica JWT. Ritorna l'utente (stessa forma dei campi decodificati
// da un JWT agente) o null se il token è sconosciuto/scaduto/revocato/utente
// disabilitato.
export async function verifyApiToken(rawToken) {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;

  const row = (await query(
    `SELECT t.id AS token_id, t.scopes, t.role_cap, u.id, u.email, u.name, u.role, u.site_id, u.token_version, u.status
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > NOW()`,
    [hashToken(rawToken)]
  )).rows[0];

  if (!row || row.status !== "active") return null;

  query("UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1", [row.token_id]).catch(() => {});

  // role_cap abbassa il ruolo effettivo del token SOLO se il proprietario è
  // superadmin/admin (vedi db/136): per qualunque altro ruolo il cap non
  // eleva mai, quindi va semplicemente ignorato.
  const effectiveRole = row.role_cap && (row.role === "superadmin" || row.role === "admin")
    ? row.role_cap
    : row.role;

  return {
    sub: row.id, email: row.email, name: row.name, role: effectiveRole,
    site_id: row.site_id, token_version: row.token_version, agent: true, api_token: true,
    scopes: Array.isArray(row.scopes) && row.scopes.length > 0 ? row.scopes : ["read"],
  };
}

export function isApiTokenFormat(rawToken) {
  return typeof rawToken === "string" && rawToken.startsWith(TOKEN_PREFIX);
}

export async function listApiTokens(userId) {
  return (await query(
    `SELECT id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at, scopes, role_cap
     FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  )).rows;
}

export async function revokeApiToken(userId, tokenId) {
  await query(
    "UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    [tokenId, userId]
  );
}
