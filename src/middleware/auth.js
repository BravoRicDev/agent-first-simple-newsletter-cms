import jwt from "jsonwebtoken";
import config from "../config.js";
import { query } from "../db.js";
import { isApiTokenFormat, verifyApiToken } from "../services/api-tokens.js";

export async function requireAuth(req, res, next) {
  const fromCookie = !!req.cookies?.token;
  let token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    if (req.path.startsWith("/api")) {
      return res.status(401).json({ error: res.locals.t("api.auth.authRequired") });
    }
    return res.redirect("/login");
  }

  // Token API di lunga durata (n8n/automazioni non interattive): riga a sé
  // in api_tokens, revocabile singolarmente — non passa da jwt.verify né dal
  // controllo token_version (vedi services/api-tokens.js sul perché).
  if (isApiTokenFormat(token)) {
    const apiUser = await verifyApiToken(token).catch(() => null);
    if (!apiUser) {
      return res.status(401).json({ error: res.locals.t("api.auth.invalidToken") });
    }
    req.user = apiUser;
    res.locals.user = apiUser;
    return next();
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    if (req.path.startsWith("/api")) {
      return res.status(401).json({ error: res.locals.t("api.auth.invalidToken") });
    }
    if (fromCookie) res.clearCookie("token");
    return res.redirect("/login");
  }

  try {
    const result = await query("SELECT token_version, status FROM users WHERE id = $1", [decoded.sub]);
    const dbUser = result.rows[0];
    if (!dbUser || dbUser.status === "disabled" || dbUser.token_version !== decoded.token_version) {
      if (fromCookie) res.clearCookie("token");
      if (req.path.startsWith("/api")) return res.status(401).json({ error: res.locals.t("api.auth.invalidSession") });
      return res.redirect("/login");
    }
  } catch {
    if (req.path.startsWith("/api")) {
      return res.status(503).json({ error: res.locals.t("api.common.serviceUnavailable") });
    }
    return res.redirect("/login");
  }

  req.user = decoded;
  res.locals.user = decoded;
  next();
}
