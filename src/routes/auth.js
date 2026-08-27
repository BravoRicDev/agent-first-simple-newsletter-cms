import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import config from "../config.js";
import { query } from "../db.js";
import { generateAndSend, verify } from "../services/magic-link.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Converte una durata JWT ("24h", "7d", "90m", "600" = secondi) in ms per il
// maxAge del cookie. Il cookie deve scadere INSIEME al token, non prima.
function jwtExpiryToMs(expiresIn) {
  if (!expiresIn) return 24 * 60 * 60 * 1000;
  const match = String(expiresIn).match(/^(\d+)\s*(s|m|h|d|w)?$/i);
  if (!match) return 24 * 60 * 60 * 1000;
  const n = parseInt(match[1], 10);
  const unit = (match[2] || "s").toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  return n * mult;
}

const loginSchema = z.object({
  email: z.string().email(),
});

router.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email } = loginSchema.parse(req.body);
    // Risposta identica indipendentemente dal fatto che l'account esista o meno
    // (evita user enumeration): l'unico segnale distinguibile resta il tempo di
    // risposta, non eliminabile senza introdurre un ritardo artificiale.
    await generateAndSend(email);
    res.json({ sent: true, message: res.locals.t("api.auth.checkEmailForCode") });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: res.locals.t("api.common.invalidEmail") });
    }
    next(err);
  }
});

router.post("/api/auth/verify", async (req, res, next) => {
  try {
    const { token, otp } = req.body;
    if (!token || !otp) {
      return res.status(400).json({ error: res.locals.t("api.auth.tokenAndOtpRequired") });
    }
    const user = await verify(token, otp);
    if (!user) {
      return res.status(401).json({ error: res.locals.t("api.auth.invalidOrExpiredLink") });
    }
    if (user.status === "disabled") {
      return res.status(403).json({ error: res.locals.t("api.auth.userDisabled"), disabled: true });
    }
    const jwtToken = jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role, site_id: user.site_id, token_version: user.token_version },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn, algorithm: "HS256" }
    );
    res.cookie("token", jwtToken, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/",
      // maxAge fisso a 24h: se JWT_EXPIRES_IN > 24h (es. "7d"), il token
      // restava valido via header Authorization oltre la vita del cookie.
      maxAge: jwtExpiryToMs(config.jwtExpiresIn),
    });
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, site_id: user.site_id } });
  } catch (err) {
    next(err);
  }
});

router.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post("/api/auth/logout", async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (token) {
      const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
      if (decoded?.sub) {
        await query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [decoded.sub]);
      }
    }
  } catch {
    // token già scaduto/non valido: nessuna sessione da invalidare lato server
  }
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/login", (req, res) => {
  res.render("auth/login", { layout: false });
});

router.get("/login/verify", (req, res) => {
  res.render("auth/verify", { token: req.query.token || "", layout: false });
});

// Verifica OTP da CLI: richiede sia il token della magic-link (48 byte random,
// ricevuto via email insieme all'OTP) sia l'OTP a 6 cifre — stesso schema a due
// fattori del flusso web (/api/auth/verify), invece di autenticare col solo OTP.
router.post("/api/agent/verify-otp", async (req, res, next) => {
  try {
    const { email, token, otp } = req.body;
    if (!email || !token || !otp) {
      return res.status(400).json({ error: res.locals.t("api.auth.emailTokenAndOtpRequired") });
    }

    const user = await verify(token, otp);
    if (!user) {
      return res.status(401).json({ error: res.locals.t("api.auth.invalidOrExpiredOtp") });
    }
    if (user.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(401).json({ error: res.locals.t("api.auth.invalidOrExpiredOtp") });
    }
    if (user.status === "disabled") {
      return res.status(403).json({ error: res.locals.t("api.auth.userDisabled") });
    }

    const jwtToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        site_id: user.site_id,
        token_version: user.token_version,
        agent: true,
      },
      config.jwtSecret,
      { expiresIn: "7d", algorithm: "HS256" }
    );

    res.json({
      token: jwtToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

// ── Refresh token per agenti ───────────────────────────────────────────────

router.post("/api/agent/refresh-token", requireAuth, async (req, res, next) => {
  try {
    if (!req.user?.agent) {
      return res.status(403).json({ error: res.locals.t("api.auth.agentsOnlyEndpoint") });
    }

    const user = (await query(
      "SELECT id, email, name, role, site_id, token_version FROM users WHERE id = $1 AND status = 'active'",
      [req.user.sub]
    )).rows[0];
    if (!user) return res.status(401).json({ error: res.locals.t("api.auth.userNotFoundOrDisabled") });

    const jwtToken = jwt.sign(
      {
        sub: user.id, email: user.email, name: user.name,
        role: user.role, site_id: user.site_id,
        token_version: user.token_version,
        agent: true,
      },
      config.jwtSecret,
      { expiresIn: "7d", algorithm: "HS256" }
    );

    res.json({
      token: jwtToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
  } catch (err) { next(err); }
});

// Verifica token JWT per i moduli satellite (collego-sales).
// Contratto richiesto dal satellite: POST { token } ->
// { success: true, user: { sub, id, email, name, surname, role, site_id } }
// oppure errore { success: false, user: null }. Nessuna rotazione del token.
router.post("/api/agent/verify-token", async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({ success: false, user: null, error: "token_required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    } catch {
      return res.status(401).json({ success: false, user: null, error: "invalid_token" });
    }

    const session = (await query(
      "SELECT token_version, status FROM users WHERE id = $1",
      [decoded.sub]
    )).rows[0];
    if (!session || session.status === "disabled" || session.token_version !== decoded.token_version) {
      return res.status(401).json({ success: false, user: null, error: "invalid_session" });
    }

    const user = (await query(
      "SELECT id, email, name, surname, role, site_id FROM users WHERE id = $1",
      [decoded.sub]
    )).rows[0];
    // L'utente puo' sparire tra le due query (cancellazione concorrente):
    // meglio un 401 pulito che un 500.
    if (!user) {
      return res.status(401).json({ success: false, user: null, error: "invalid_session" });
    }

    res.json({
      success: true,
      user: {
        sub: decoded.sub,
        id: user.id,
        email: user.email,
        name: user.name,
        surname: user.surname,
        role: user.role,
        site_id: user.site_id,
      },
    });
  } catch (err) { next(err); }
});

export default router;
