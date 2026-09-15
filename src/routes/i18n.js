import { Router } from "express";
import { SUPPORTED_LANGS } from "../middleware/i18n.js";
import config from "../config.js";

const router = Router();

router.post("/api/i18n/lang", (req, res) => {
  const { lang } = req.body || {};
  if (!SUPPORTED_LANGS.includes(lang)) {
    return res.status(400).json({ error: res.locals.t("api.i18n.unsupportedLanguage") });
  }
  // secure come gli altri cookie di sessione: prima mancava anche in produzione.
  res.cookie("lang", lang, { maxAge: 365 * 24 * 3600000, httpOnly: true, sameSite: "lax", secure: config.nodeEnv === "production" });
  res.json({ ok: true, lang });
});

export default router;
