import jwt from "jsonwebtoken";
import config from "../config.js";
import { validateRedirectUri } from "./satellites.js";

export function jwtExpiryToMs(expiresIn) {
  if (!expiresIn) return 24 * 60 * 60 * 1000;
  const match = String(expiresIn).match(/^(\d+)\s*(s|m|h|d|w)?$/i);
  if (!match) return 24 * 60 * 60 * 1000;
  const n = parseInt(match[1], 10);
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[(match[2] || "s").toLowerCase()];
  return n * mult;
}
export function signSessionToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, site_id: user.site_id, token_version: user.token_version },
    config.jwtSecret, { expiresIn: config.jwtExpiresIn, algorithm: "HS256" });
}
export function setSessionCookie(res, token) {
  res.cookie("token", token, { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "lax", path: "/", maxAge: jwtExpiryToMs(config.jwtExpiresIn) });
}
// Emette la sessione web e risponde col payload storico di /api/auth/verify.
export async function issueLoginResponse(res, user, redirectUri) {
  setSessionCookie(res, signSessionToken(user));
  const redirect_to = await validateRedirectUri(redirectUri);
  return res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, site_id: user.site_id }, redirect_to });
}
