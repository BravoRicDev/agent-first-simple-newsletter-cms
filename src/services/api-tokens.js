import crypto from "crypto";
import { query } from "../db.js";

const TOKEN_PREFIX = "agtok_";

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Il valore in chiaro esiste solo qui, al momento della creazione — mai
// salvato, mai più recuperabile dopo (stesso modello dei PAT GitHub/Stripe).
export async function createApiToken(userId, name, expiresInDays) {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 14) + "…";
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000);

  const result = await query(
    `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [userId, name.slice(0, 255), hashToken(raw), prefix, expiresAt]
  );

  return { id: result.rows[0].id, token: raw, prefix, expiresAt, createdAt: result.rows[0].created_at };
}

// Usata da requireAuth per i token che iniziano con TOKEN_PREFIX, al posto
// della verifica JWT. Ritorna l'utente (stessa forma dei campi decodificati
// da un JWT agente) o null se il token è sconosciuto/scaduto/revocato/utente
// disabilitato.
export async function verifyApiToken(rawToken) {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;

  const row = (await query(
    `SELECT t.id AS token_id, u.id, u.email, u.name, u.role, u.site_id, u.token_version, u.status
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > NOW()`,
    [hashToken(rawToken)]
  )).rows[0];

  if (!row || row.status !== "active") return null;

  query("UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1", [row.token_id]).catch(() => {});

  return {
    sub: row.id, email: row.email, name: row.name, role: row.role,
    site_id: row.site_id, token_version: row.token_version, agent: true, api_token: true,
  };
}

export function isApiTokenFormat(rawToken) {
  return typeof rawToken === "string" && rawToken.startsWith(TOKEN_PREFIX);
}

export async function listApiTokens(userId) {
  return (await query(
    `SELECT id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at
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
