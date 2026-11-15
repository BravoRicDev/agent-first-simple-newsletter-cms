import { query } from "../db.js";
import config from "../config.js";
import { auditLog } from "./audit.js";
import { createChallenge, getChallenge, consumeChallenge } from "./mfa.js";

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;
function err(code) { const e = new Error(code); e.code = code; return e; }
let libP = null;
const lib = () => (libP ||= import("@simplewebauthn/server"));

// rpID/origin: env esplicite > (produzione) MAGIC_LINK_BASE_URL > (sviluppo/test) header Host della richiesta.
export function rpFromRequest(req) {
  const rpName = config.appName;
  const envId = process.env.WEBAUTHN_RP_ID, envOrigin = process.env.WEBAUTHN_ORIGIN;
  if (envId && envOrigin) return { rpID: envId, origin: envOrigin, rpName };
  if (config.nodeEnv === "production") {
    const u = new URL(config.magicLinkBaseUrl);
    return { rpID: envId || u.hostname, origin: envOrigin || u.origin, rpName };
  }
  const host = String(req.get("host") || "");
  if (!HOST_RE.test(host)) throw err("INVALID_HOST");
  return { rpID: envId || String(req.hostname || host.split(":")[0]), origin: envOrigin || `${req.protocol}://${host}`, rpName };
}

export async function beginRegistration(user, req) {
  const { rpID, rpName } = rpFromRequest(req);
  const { generateRegistrationOptions } = await lib();
  const existing = (await query("SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1", [user.id])).rows;
  const options = await generateRegistrationOptions({
    rpName, rpID, userName: user.email, userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(String(user.id)), attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challenge_id = await createChallenge(user.id, "webauthn_reg", { challenge: options.challenge }, 300);
  return { options, challenge_id };
}

export async function finishRegistration(user, req, { challengeId, response, name }, deps = {}) {
  const ch = await getChallenge(challengeId, "webauthn_reg");
  if (!ch || ch.user_id !== user.id) throw err("INVALID_CHALLENGE");
  if (!(await consumeChallenge(challengeId))) throw err("INVALID_CHALLENGE");   // monouso anche in caso di fallimento
  const { rpID, origin } = rpFromRequest(req);
  const verify = deps.verifyRegistrationResponse || (await lib()).verifyRegistrationResponse;
  const v = await verify({ response, expectedChallenge: ch.data.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  if (!v?.verified || !v.registrationInfo) throw err("VERIFICATION_FAILED");
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  try {
    await query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [user.id, credential.id, Buffer.from(credential.publicKey).toString("base64url"), credential.counter ?? 0,
       Array.isArray(response?.response?.transports) ? response.response.transports : [], credentialDeviceType || null, !!credentialBackedUp,
       String(name || "Passkey").slice(0, 100)]);
  } catch (e) {
    if (e.code === "23505") throw err("DUPLICATE_CREDENTIAL");
    throw e;
  }
  await auditLog({ userId: user.id, siteId: user.site_id ?? null, entityType: "user", entityId: user.id, action: "mfa_passkey_add", ipAddress: req.ip });
  return { ok: true };
}

export async function beginAuthentication(req, { userId = null, userVerification = "discouraged", loginChallengeId = null } = {}) {
  const { rpID } = rpFromRequest(req);
  const { generateAuthenticationOptions } = await lib();
  let allowCredentials;
  if (userId) {
    const rows = (await query("SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1", [userId])).rows;
    allowCredentials = rows.map((c) => ({ id: c.credential_id, transports: c.transports }));
  }
  const options = await generateAuthenticationOptions({ rpID, allowCredentials, userVerification });
  const challenge_id = await createChallenge(userId, "webauthn_auth", { challenge: options.challenge, login_challenge_id: loginChallengeId }, 300);
  return { options, challenge_id };
}

// Ritorna { userId }. expectUserId: l'utente DEVE essere quello del ticket MFA. requireUV: passkey come primo fattore.
export async function finishAuthentication(req, { challengeId, response, expectUserId = null, requireUV = false }, deps = {}) {
  const ch = await getChallenge(challengeId, "webauthn_auth");
  if (!ch) throw err("INVALID_CHALLENGE");
  if (expectUserId && ch.user_id !== expectUserId) throw err("INVALID_CHALLENGE");
  if (!(await consumeChallenge(challengeId))) throw err("INVALID_CHALLENGE");
  const cred = (await query("SELECT * FROM webauthn_credentials WHERE credential_id = $1", [String(response?.id || "")])).rows[0];
  if (!cred) throw err("UNKNOWN_CREDENTIAL");
  if (expectUserId && cred.user_id !== expectUserId) throw err("INVALID_CHALLENGE");
  if (ch.user_id && cred.user_id !== ch.user_id) throw err("INVALID_CHALLENGE");
  const { rpID, origin } = rpFromRequest(req);
  const verify = deps.verifyAuthenticationResponse || (await lib()).verifyAuthenticationResponse;
  const v = await verify({
    response, expectedChallenge: ch.data.challenge, expectedOrigin: origin, expectedRPID: rpID,
    credential: { id: cred.credential_id, publicKey: Buffer.from(cred.public_key, "base64url"), counter: Number(cred.counter), transports: cred.transports },
    requireUserVerification: !!requireUV,
  });
  if (!v?.verified) throw err("VERIFICATION_FAILED");
  await query("UPDATE webauthn_credentials SET counter = $2, last_used_at = NOW() WHERE id = $1", [cred.id, v.authenticationInfo.newCounter]);
  return { userId: cred.user_id };
}

export async function listPasskeys(userId) {
  return (await query("SELECT id, name, created_at, last_used_at, device_type FROM webauthn_credentials WHERE user_id = $1 ORDER BY id", [userId])).rows;
}
export async function deletePasskey(userId, id) {
  const r = await query("DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
  if (r.rowCount) await auditLog({ userId, siteId: null, entityType: "user", entityId: userId, action: "mfa_passkey_del", ipAddress: null });
  return r.rowCount === 1;
}
