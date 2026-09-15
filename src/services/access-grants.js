import crypto from "crypto";
import { query } from "../db.js";
import { isValidProtectedRelPath } from "./media-utils.js";

// ─────────────────────────────────────────────────────────────────────────
// R1 — Permessi di accesso a contenuti protetti (GAP-ANALYSIS §2).
//
// Un access_grant è "un permesso nominativo + token + scadenza" per
// scaricare UN file di media-protected via rotta pubblica GET /shared/:token,
// senza account CMS. Token generato con crypto.randomBytes(32) — stesso
// pattern di /quote/:token (src/services/opportunities.js) e /pay/:token
// (src/services/payments.js). Il consumo è ATOMICO (UPDATE condizionale con
// RETURNING) per evitare race condition TOCTOU su max_uses.
// ─────────────────────────────────────────────────────────────────────────

const VALID_SOURCES = ["manual", "purchase", "challenge", "api"];

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase().slice(0, 255);
}

// POSTGRES ripassa i campi TIMESTAMPTZ/NUMERIC come stringhe/Date a seconda
// del driver: normalizza i tipi noti per un'API JSON pulita.
function mapGrant(row) {
  if (!row) return row;
  return {
    ...row,
    used_count: Number(row.used_count) || 0,
    max_uses: row.max_uses !== null ? Number(row.max_uses) : null,
  };
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ── Creazione ────────────────────────────────────────────────────────────

export async function createAccessGrant(siteId, { email = "", mediaPath = "", expiresAt = null, maxUses = null, source = "manual", createdBy = null } = {}) {
  const cleanPath = String(mediaPath || "").trim().slice(0, 500);
  // Rifiuta subito percorsi malformati (anti path-traversal anche a livello
  // di dato: media_path viene usato dal serve sotto PROTECTED_ROOT).
  if (!isValidProtectedRelPath(cleanPath)) return null;

  const cleanSource = VALID_SOURCES.includes(String(source)) ? String(source) : "manual";
  const cleanMax = maxUses === null || maxUses === "" || maxUses === undefined
    ? null
    : Math.max(parseInt(maxUses, 10) || 0, 0);

  const token = generateToken();
  const row = (await query(
    `INSERT INTO access_grants
       (site_id, email, token, media_path, expires_at, max_uses, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [siteId, normalizeEmail(email), token, cleanPath,
     expiresAt || null, cleanMax, cleanSource, createdBy || null]
  )).rows[0];
  return mapGrant(row);
}

// ── Lettura ──────────────────────────────────────────────────────────────

export async function resolveAccessGrant(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const row = (await query(
    "SELECT * FROM access_grants WHERE token = $1",
    [t]
  )).rows[0];
  return mapGrant(row || null);
}

export async function listAccessGrants(siteId, { email = null } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (email) {
    params.push(normalizeEmail(email));
    where += ` AND email = $${params.length}`;
  }
  const rows = (await query(
    `SELECT * FROM access_grants WHERE ${where} ORDER BY created_at DESC`,
    params
  )).rows;
  return rows.map(mapGrant);
}

// ── Consumo atomico ──────────────────────────────────────────────────────

// Verifica scadenza/max_uses e, se ok, incrementa used_count in modo
// ATOMICO. L'UPDATE condizionale evita il classico TOCTOU:
//   SELECT (used_count < max_uses) → UPDATE ... e se due richieste girano in
//   parallelo sulla stessa riga, entrambe leggerebbero used_count==max-1 e
//   l'una sovrascriverebbe l'altra. Qui solo UNA delle due passa il WHERE
//   `used_count < max_uses`; l'altra non tocca la riga (→ exhausted).
export async function checkAndConsumeGrant(token) {
  const grant = await resolveAccessGrant(token);
  if (!grant) return { ok: false, reason: "not_found" };

  if (grant.expires_at && new Date(grant.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const row = (await query(
    `UPDATE access_grants
     SET used_count = used_count + 1
     WHERE id = $1 AND (max_uses IS NULL OR used_count < max_uses)
     RETURNING *`,
    [grant.id]
  )).rows[0];
  if (!row) return { ok: false, reason: "exhausted" };

  return { ok: true, grant: mapGrant(row) };
}

// ── Revoca ───────────────────────────────────────────────────────────────

export async function revokeAccessGrant(siteId, grantId) {
  const result = await query(
    "DELETE FROM access_grants WHERE id = $1 AND site_id = $2",
    [parseInt(grantId, 10), siteId]
  );
  return (result.rowCount || 0) > 0;
}