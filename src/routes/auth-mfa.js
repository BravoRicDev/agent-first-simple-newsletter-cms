import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { issueLoginResponse } from "../services/session.js";
import {
  getChallenge, bumpChallengeAttempts, consumeChallenge, verifySecondFactor, getMfaState, getMfaPolicy,
  beginTotpEnrollment, confirmTotpEnrollment, disableTotp, generateBackupCodes, invalidateMfaCache,
} from "../services/mfa.js";
import { beginAuthentication, finishAuthentication, beginRegistration, finishRegistration, listPasskeys, deletePasskey } from "../services/webauthn.js";

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "too_many_requests" } });
router.use(["/api/auth/mfa", "/api/auth/passkey", "/api/auth/security"], limiter);

async function loadActiveUser(id) {
  const u = (await query("SELECT id, email, name, role, site_id, status, token_version FROM users WHERE id = $1", [id])).rows[0];
  return u && u.status !== "disabled" ? u : null;
}
const sessionOnly = [requireAuth, (req, res, next) => (req.user?.agent || req.user?.api_token ? res.status(403).json({ error: "session_required" }) : next())];
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (err) { next(err); } };
const KNOWN = { ALREADY_ENABLED: [409, "already_enabled"], NO_PENDING: [400, "no_pending"], INVALID_CODE: [400, "invalid_code"], INVALID_CHALLENGE: [400, "invalid_challenge"],
  VERIFICATION_FAILED: [400, "verification_failed"], DUPLICATE_CREDENTIAL: [409, "duplicate_credential"], UNKNOWN_CREDENTIAL: [401, "invalid_credential"], INVALID_HOST: [400, "invalid_host"] };
const known = (res, err) => { const k = KNOWN[err?.code]; if (!k) return false; res.status(k[0]).json({ error: k[1], code: k[1] }); return true; };

// ---- login: secondo passaggio (pubblico, protetto dal ticket) ----
router.post("/api/auth/mfa/verify", wrap(async (req, res) => {
  const { ticket, totp_code, backup_code } = req.body || {};
  const ch = await getChallenge(ticket, "mfa_login");
  if (!ch) return res.status(401).json({ error: "invalid_ticket" });
  const ok = await verifySecondFactor(ch.user_id, { totp_code, backup_code });
  if (!ok) { await bumpChallengeAttempts(ticket); return res.status(401).json({ error: "invalid_code" }); }
  if (!(await consumeChallenge(ticket))) return res.status(401).json({ error: "invalid_ticket" });
  const user = await loadActiveUser(ch.user_id);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  return issueLoginResponse(res, user, ch.data?.redirect_uri);
}));

router.post("/api/auth/mfa/webauthn/options", wrap(async (req, res) => {
  const ch = await getChallenge(req.body?.ticket, "mfa_login");
  if (!ch) return res.status(401).json({ error: "invalid_ticket" });
  try { return res.json(await beginAuthentication(req, { userId: ch.user_id, userVerification: "discouraged", loginChallengeId: req.body.ticket })); }
  catch (err) { if (known(res, err)) return undefined; throw err; }
}));

router.post("/api/auth/mfa/webauthn/verify", wrap(async (req, res) => {
  const { ticket, challenge_id, response } = req.body || {};
  const ch = await getChallenge(ticket, "mfa_login");
  if (!ch) return res.status(401).json({ error: "invalid_ticket" });
  try {
    await finishAuthentication(req, { challengeId: challenge_id, response, expectUserId: ch.user_id });
  } catch (err) {
    await bumpChallengeAttempts(ticket);
    return res.status(401).json({ error: "invalid_credential" });
  }
  if (!(await consumeChallenge(ticket))) return res.status(401).json({ error: "invalid_ticket" });
  const user = await loadActiveUser(ch.user_id);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  return issueLoginResponse(res, user, ch.data?.redirect_uri);
}));

// ---- passkey come PRIMO fattore (userVerification obbligatoria => gia' multi-fattore) ----
router.post("/api/auth/passkey/options", wrap(async (req, res) => {
  try { return res.json(await beginAuthentication(req, { userVerification: "required" })); }
  catch (err) { if (known(res, err)) return undefined; throw err; }
}));
router.post("/api/auth/passkey/verify", wrap(async (req, res) => {
  const { challenge_id, response, redirect_uri } = req.body || {};
  let out;
  try { out = await finishAuthentication(req, { challengeId: challenge_id, response, requireUV: true }); }
  catch (err) { return res.status(401).json({ error: "invalid_credential" }); }
  const user = await loadActiveUser(out.userId);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  return issueLoginResponse(res, user, redirect_uri);
}));

// ---- self-service (solo sessione cookie; mai agent/API token) ----
router.get("/api/auth/security", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  const state = await getMfaState(user.id);
  return res.json({ ...state, policy_required: (await getMfaPolicy(user)).required, passkeys_list: await listPasskeys(user.id) });
}));

router.post("/api/auth/security/totp/begin", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  try { return res.json(await beginTotpEnrollment(user)); } catch (err) { if (known(res, err)) return undefined; throw err; }
}));
router.post("/api/auth/security/totp/confirm", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  try { return res.json(await confirmTotpEnrollment(user, req.body?.code)); } catch (err) { if (known(res, err)) return undefined; throw err; }
}));

async function lastFactorGuard(res, user) {
  if ((await getMfaPolicy(user)).required && (await getMfaState(user.id)).passkeys === 0) { res.status(409).json({ error: "mfa_required_by_policy" }); return true; }
  return false;
}
router.post("/api/auth/security/totp/disable", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  if (!(await verifySecondFactor(user.id, req.body || {}))) return res.status(401).json({ error: "invalid_code" });
  if (await lastFactorGuard(res, user)) return undefined;
  await disableTotp(user);
  return res.json({ ok: true });
}));
router.post("/api/auth/security/backup-codes/regenerate", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  if (!(await verifySecondFactor(user.id, { totp_code: req.body?.totp_code }))) return res.status(401).json({ error: "invalid_code" });
  return res.json({ backup_codes: await generateBackupCodes(user.id) });
}));

router.post("/api/auth/security/passkeys/options", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  try { return res.json(await beginRegistration(user, req)); } catch (err) { if (known(res, err)) return undefined; throw err; }
}));
router.post("/api/auth/security/passkeys/register", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  try {
    await finishRegistration(user, req, { challengeId: req.body?.challenge_id, response: req.body?.response, name: req.body?.name });
    invalidateMfaCache(user.id);
    return res.json({ ok: true });
  } catch (err) { if (known(res, err)) return undefined; throw err; }
}));
router.delete("/api/auth/security/passkeys/:id", ...sessionOnly, wrap(async (req, res) => {
  const user = await loadActiveUser(req.user.sub);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  const id = /^\d+$/.test(req.params.id) ? parseInt(req.params.id, 10) : 0;
  const state = await getMfaState(user.id);
  if (!state.totp_enabled && state.passkeys <= 1 && (await getMfaPolicy(user)).required) return res.status(409).json({ error: "mfa_required_by_policy" });
  const ok = id ? await deletePasskey(user.id, id) : false;
  if (ok) invalidateMfaCache(user.id);
  return res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not_found" });
}));

export default router;
