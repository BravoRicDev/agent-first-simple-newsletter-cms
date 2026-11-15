import { Router } from "express";
import rateLimit from "express-rate-limit";
import config from "../config.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { requireAuth } from "../middleware/auth.js";
import { signSessionToken, setSessionCookie } from "../services/session.js";
import { validateRedirectUri } from "../services/satellites.js";
import { hasSecondFactor, createLoginChallenge, getChallenge } from "../services/mfa.js";
import { listProviders, getProvider, createProvider, updateProvider, deleteProvider, publicProvider, buildAuthRequest, completeLogin, mapOidcError, redirectUri } from "../services/oidc.js";
import { auditLog } from "../services/audit.js";

const router = Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "too_many_requests" } });
const COOKIE = { httpOnly: true, sameSite: "lax", secure: config.nodeEnv === "production", path: "/auth/oidc" };
const idOf = (v) => (/^\d+$/.test(String(v)) ? parseInt(v, 10) : 0);

router.get("/auth/oidc/providers", limiter, resolveSite, async (req, res, next) => {
  try {
    if (!req.site?.id) return res.json({ providers: [] });
    const rows = await listProviders({ siteId: req.site.id, includeGlobal: true, onlyEnabled: true });
    return res.json({ providers: rows.map((p) => ({ id: p.id, slug: p.slug, name: p.name })) });
  } catch (err) { return next(err); }
});

router.get("/auth/oidc/callback", limiter, async (req, res) => {
  const fail = (key) => { res.clearCookie("oidc_state", { path: "/auth/oidc" }); return res.redirect("/login?error=" + encodeURIComponent(key)); };
  try {
    const { code, state, error } = req.query;
    if (error || typeof code !== "string" || typeof state !== "string") return fail("oidc_failed");
    const ch = await getChallenge(state, "oidc");
    if (!ch) return fail("state_mismatch");
    const provider = await getProvider(ch.data?.provider_id);
    if (!provider || !provider.enabled) return fail("oidc_failed");
    const { user, post_login } = await completeLogin(provider, { code, state, browserState: req.cookies?.oidc_state });
    res.clearCookie("oidc_state", { path: "/auth/oidc" });
    if (provider.trust_idp_mfa !== true && (await hasSecondFactor(user.id))) {
      const ticket = await createLoginChallenge(user, { redirect_uri: post_login });
      return res.redirect("/login/verify?ticket=" + encodeURIComponent(ticket));
    }
    setSessionCookie(res, signSessionToken(user));
    return res.redirect((await validateRedirectUri(post_login)) || "/admin/dashboard");
  } catch (e) { return fail(mapOidcError(e)); }
});

// NB: registrata DOPO /callback e /providers (path distinti: :id e' numerico)
router.get("/auth/oidc/:id/start", limiter, async (req, res) => {
  try {
    const provider = await getProvider(idOf(req.params.id));
    if (!provider || !provider.enabled) return res.status(404).send("Not found");
    const { url, state } = await buildAuthRequest(provider, { redirect_uri: req.query.redirect_uri });
    res.cookie("oidc_state", state, { ...COOKIE, maxAge: 600000 });
    return res.redirect(url);
  } catch (e) { mapOidcError(e); return res.redirect("/login?error=oidc_failed"); }
});

// ---- amministrazione provider (sessione, admin|superadmin) ----
const adminOnly = [requireAuth, (req, res, next) => {
  if (req.user?.agent || req.user?.api_token) return res.status(403).json({ error: "session_required" });
  if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "forbidden" });
  return next();
}];
const inScope = (user, p) => user.role === "superadmin" || (p && p.site_id === user.site_id);
const invalid = (res, err) => (err?.code === "INVALID_PROVIDER" ? (res.status(400).json({ error: "invalid_provider", field: err.field }), true) : false);

router.get("/admin/api/oidc-providers", ...adminOnly, async (req, res, next) => {
  try {
    const rows = req.user.role === "superadmin" ? await listProviders({}) : await listProviders({ siteId: req.user.site_id, includeGlobal: false });
    return res.json({ providers: rows.map(publicProvider) });
  } catch (err) { return next(err); }
});
router.post("/admin/api/oidc-providers", ...adminOnly, async (req, res, next) => {
  try {
    const body = { ...(req.body || {}) };
    if (req.user.role !== "superadmin") {
      if (body.site_id === null || body.site_id === "") return res.status(403).json({ error: "forbidden" });
      body.site_id = req.user.site_id;
    }
    const p = await createProvider(body);
    await auditLog({ userId: req.user.sub, siteId: p.site_id, entityType: "oidc_provider", entityId: p.id, action: "oidc_provider_save", newData: { slug: p.slug }, ipAddress: req.ip });
    return res.status(201).json({ provider: publicProvider(p) });
  } catch (err) { if (invalid(res, err)) return undefined; return next(err); }
});
router.put("/admin/api/oidc-providers/:id", ...adminOnly, async (req, res, next) => {
  try {
    const cur = await getProvider(idOf(req.params.id));
    if (!cur || !inScope(req.user, cur)) return res.status(404).json({ error: "not_found" });
    const body = { ...(req.body || {}) };
    if (req.user.role !== "superadmin") body.site_id = req.user.site_id;
    const p = await updateProvider(cur.id, body);
    await auditLog({ userId: req.user.sub, siteId: p.site_id, entityType: "oidc_provider", entityId: p.id, action: "oidc_provider_save", newData: { slug: p.slug }, ipAddress: req.ip });
    return res.json({ provider: publicProvider(p) });
  } catch (err) { if (invalid(res, err)) return undefined; return next(err); }
});
router.delete("/admin/api/oidc-providers/:id", ...adminOnly, async (req, res, next) => {
  try {
    const cur = await getProvider(idOf(req.params.id));
    if (!cur || !inScope(req.user, cur)) return res.status(404).json({ error: "not_found" });
    await deleteProvider(cur.id);
    await auditLog({ userId: req.user.sub, siteId: cur.site_id, entityType: "oidc_provider", entityId: cur.id, action: "oidc_provider_del", ipAddress: req.ip });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});
router.get("/admin/security/sso", ...adminOnly, (req, res) => res.render("admin/security/sso", { redirectUri: redirectUri(), isSuper: req.user.role === "superadmin" }));

export default router;
