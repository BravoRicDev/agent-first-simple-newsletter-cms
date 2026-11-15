import jwt from "jsonwebtoken";
import config from "../config.js";
import { needsEnrollment } from "../services/mfa.js";

// Montato come app.use("/admin", mfaEnrollGuard): req.originalUrl e' il path completo.
export async function mfaEnrollGuard(req, res, next) {
  try {
    const p = req.originalUrl.split("?")[0];
    if (p === "/admin/security" || p.startsWith("/admin/security/") || p.startsWith("/admin/api/")) return next();
    const token = req.cookies?.token;
    if (!token) return next();
    let d;
    try { d = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }); } catch { return next(); }
    if (d.role !== "admin" && d.role !== "superadmin") return next();
    if (!(await needsEnrollment({ id: d.sub, role: d.role, site_id: d.site_id }))) return next();
    if (req.method !== "GET") return res.status(403).render("error", { message: res.locals.t("security.enrollRequired") });
    return res.redirect("/admin/security?enroll=1");
  } catch (err) { next(err); }
}
