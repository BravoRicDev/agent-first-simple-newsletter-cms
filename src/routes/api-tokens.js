import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { createApiToken, listApiTokens, revokeApiToken } from "../services/api-tokens.js";

const router = Router();

const ALLOWED_DAYS = new Set([30, 60, 90, 120, 180, 365]);

router.get("/admin/api-tokens", requireAuth, async (req, res, next) => {
  try {
    const tokens = await listApiTokens(req.user.sub);
    res.render("admin/api-tokens/index", { tokens, newToken: null, baseUrl: req.protocol + "://" + req.get("host") });
  } catch (err) { next(err); }
});

router.post("/admin/api-tokens", requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const days = ALLOWED_DAYS.has(parseInt(req.body.expires_days, 10)) ? parseInt(req.body.expires_days, 10) : 120;
    if (!name) return res.status(400).render("error", { message: "Il nome è obbligatorio." });

    const created = await createApiToken(req.user.sub, name, days);
    const tokens = await listApiTokens(req.user.sub);
    // Il token in chiaro è mostrato SOLO in questa risposta: non più
    // recuperabile dopo, né da questa app né dal database (solo l'hash).
    res.render("admin/api-tokens/index", { tokens, newToken: created, baseUrl: req.protocol + "://" + req.get("host") });
  } catch (err) { next(err); }
});

router.post("/admin/api-tokens/:id/revoke", requireAuth, async (req, res, next) => {
  try {
    await revokeApiToken(req.user.sub, req.params.id);
    res.redirect("/admin/api-tokens");
  } catch (err) { next(err); }
});

export default router;
