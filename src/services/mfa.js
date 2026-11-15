import crypto from "node:crypto";
import QRCode from "qrcode";
import { query } from "../db.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { generateSecret, verifyTotp, otpauthUri } from "./totp.js";
import { auditLog } from "./audit.js";
import config from "../config.js";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_FAILS = 8;
const LOCK_SECONDS = 900;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function err(code) { const e = new Error(code); e.code = code; return e; }

export async function getMfaState(userId) {
  const m = (await query("SELECT totp_enabled FROM user_mfa WHERE user_id = $1", [userId])).rows[0];
  const pk = (await query("SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1", [userId])).rows[0].n;
  const bc = (await query("SELECT COUNT(*)::int AS n FROM user_backup_codes WHERE user_id = $1 AND used_at IS NULL", [userId])).rows[0].n;
  return { totp_enabled: !!m?.totp_enabled, passkeys: pk, backup_remaining: bc };
}
export async function hasSecondFactor(userId) { const s = await getMfaState(userId); return s.totp_enabled || s.passkeys > 0; }
export async function getLoginSecondFactor(user) {
  const s = await getMfaState(user.id);
  const methods = [];
  if (s.totp_enabled) methods.push("totp");
  if (s.totp_enabled && s.backup_remaining > 0) methods.push("backup");
  if (s.passkeys > 0) methods.push("webauthn");
  return { required: s.totp_enabled || s.passkeys > 0, methods };
}

const enrollCache = new Map();
export function invalidateMfaCache(userId) { if (userId === undefined) enrollCache.clear(); else enrollCache.delete(userId); }

export async function beginTotpEnrollment(user) {
  const cur = (await query("SELECT totp_enabled FROM user_mfa WHERE user_id = $1", [user.id])).rows[0];
  if (cur?.totp_enabled) throw err("ALREADY_ENABLED");
  const secret = generateSecret();
  await query(
    `INSERT INTO user_mfa (user_id, totp_pending_enc, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET totp_pending_enc = EXCLUDED.totp_pending_enc, updated_at = NOW()`,
    [user.id, encryptSecret(secret)]);
  const uri = otpauthUri({ issuer: config.appName, account: user.email, secret });
  return { secret, otpauth_uri: uri, qr_data_url: await QRCode.toDataURL(uri) };
}

export async function confirmTotpEnrollment(user, code) {
  const row = (await query("SELECT totp_pending_enc FROM user_mfa WHERE user_id = $1", [user.id])).rows[0];
  if (!row?.totp_pending_enc) throw err("NO_PENDING");
  const v = verifyTotp(decryptSecret(row.totp_pending_enc), code);
  if (!v.ok) throw err("INVALID_CODE");
  await query(
    `UPDATE user_mfa SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled = true,
       totp_last_step = $2, fail_count = 0, locked_until = NULL, enabled_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
    [user.id, v.step]);
  const backup_codes = await generateBackupCodes(user.id);
  await auditLog({ userId: user.id, siteId: user.site_id ?? null, entityType: "user", entityId: user.id, action: "mfa_totp_enable", ipAddress: null });
  invalidateMfaCache(user.id);
  return { backup_codes };
}

// true una sola volta per step (anti-replay): l'UPDATE condizionato chiude la race tra due richieste con lo stesso codice.
export async function verifyTotpForUser(userId, code) {
  const row = (await query("SELECT totp_secret_enc, totp_last_step, totp_enabled FROM user_mfa WHERE user_id = $1", [userId])).rows[0];
  if (!row?.totp_enabled || !row.totp_secret_enc) return false;
  const v = verifyTotp(decryptSecret(row.totp_secret_enc), code, { lastStep: Number(row.totp_last_step) });
  if (!v.ok) return false;
  const upd = await query("UPDATE user_mfa SET totp_last_step = $2, updated_at = NOW() WHERE user_id = $1 AND totp_last_step < $2 RETURNING user_id", [userId, v.step]);
  return upd.rowCount === 1;
}

export async function generateBackupCodes(userId) {
  await query("DELETE FROM user_backup_codes WHERE user_id = $1", [userId]);
  const out = [];
  for (let i = 0; i < 10; i++) {
    const raw = crypto.randomBytes(5).toString("hex");
    await query("INSERT INTO user_backup_codes (user_id, code_hash) VALUES ($1, $2)", [userId, sha256(raw)]);
    out.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return out;
}
export async function consumeBackupCode(userId, code) {
  const raw = String(code ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (raw.length !== 10) return false;
  const r = await query("UPDATE user_backup_codes SET used_at = NOW() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id", [userId, sha256(raw)]);
  return r.rowCount === 1;
}

// Secondo fattore con blocco per utente: 8 errori consecutivi => 15 minuti di blocco (limita il brute force anche cambiando ticket/IP).
export async function verifySecondFactor(userId, { totp_code, backup_code } = {}) {
  const st = (await query("SELECT fail_count, locked_until FROM user_mfa WHERE user_id = $1", [userId])).rows[0];
  if (st?.locked_until && new Date(st.locked_until).getTime() > Date.now()) return false;
  let ok = false;
  if (totp_code !== undefined && totp_code !== null && String(totp_code) !== "") ok = await verifyTotpForUser(userId, totp_code);
  else if (backup_code) ok = await consumeBackupCode(userId, backup_code);
  if (ok) {
    if (st) await query("UPDATE user_mfa SET fail_count = 0, locked_until = NULL WHERE user_id = $1", [userId]);
    return true;
  }
  if (st) {
    await query(
      `UPDATE user_mfa SET fail_count = CASE WHEN fail_count + 1 >= $2 THEN 0 ELSE fail_count + 1 END,
         locked_until = CASE WHEN fail_count + 1 >= $2 THEN NOW() + ($3::int * INTERVAL '1 second') ELSE locked_until END
       WHERE user_id = $1`, [userId, MAX_FAILS, LOCK_SECONDS]);
  }
  return false;
}

export async function disableTotp(user) {
  await query("UPDATE user_mfa SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = false, fail_count = 0, locked_until = NULL, updated_at = NOW() WHERE user_id = $1", [user.id]);
  await query("DELETE FROM user_backup_codes WHERE user_id = $1", [user.id]);
  await auditLog({ userId: user.id, siteId: user.site_id ?? null, entityType: "user", entityId: user.id, action: "mfa_totp_disable", ipAddress: null });
  invalidateMfaCache(user.id);
}

// Reset da parte di un amministratore (dispositivo perso). Invalida anche le sessioni dell'utente (token_version).
export async function resetMfa(targetUserId, actor) {
  await query("DELETE FROM user_mfa WHERE user_id = $1", [targetUserId]);
  await query("DELETE FROM user_backup_codes WHERE user_id = $1", [targetUserId]);
  await query("DELETE FROM webauthn_credentials WHERE user_id = $1", [targetUserId]);
  await query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [targetUserId]);
  await auditLog({ userId: actor?.id ?? actor?.sub ?? null, siteId: actor?.site_id ?? null, entityType: "user", entityId: targetUserId, action: "mfa_reset", ipAddress: null });
  invalidateMfaCache(targetUserId);
}

export async function getMfaPolicy(user) {
  if (user.role !== "admin" && user.role !== "superadmin") return { required: false };
  if (process.env.REQUIRE_2FA_ADMINS === "1") return { required: true };
  if (user.site_id) {
    const r = (await query("SELECT value FROM settings WHERE site_id = $1 AND key = 'require_2fa_admins'", [user.site_id])).rows[0];
    if (r?.value === "1") return { required: true };
  }
  return { required: false };
}
export async function needsEnrollment(user) {
  const hit = enrollCache.get(user.id);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const value = (await getMfaPolicy(user)).required && !(await hasSecondFactor(user.id));
  enrollCache.set(user.id, { value, at: Date.now() });
  return value;
}

// ---- challenge monouso (ticket MFA, challenge WebAuthn, state OIDC) ----
export async function purgeChallenges() { await query("DELETE FROM auth_challenges WHERE expires_at < NOW() - INTERVAL '1 day'"); }
export async function createChallenge(userId, kind, data, ttlSeconds) {
  purgeChallenges().catch(() => {});
  const r = await query(
    "INSERT INTO auth_challenges (user_id, kind, data, expires_at) VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 second')) RETURNING id",
    [userId ?? null, kind, JSON.stringify(data ?? {}), ttlSeconds]);
  return r.rows[0].id;
}
export async function getChallenge(id, kind) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return (await query("SELECT * FROM auth_challenges WHERE id = $1 AND kind = $2 AND used_at IS NULL AND expires_at > NOW() AND attempts < 5", [id, kind])).rows[0] || null;
}
export async function bumpChallengeAttempts(id) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return;
  await query("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1", [id]);
}
export async function consumeChallenge(id) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return false;
  const r = await query("UPDATE auth_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING id", [id]);
  return r.rowCount === 1;
}
export const createLoginChallenge = (user, { redirect_uri = "" } = {}) => createChallenge(user.id, "mfa_login", { redirect_uri }, 300);
