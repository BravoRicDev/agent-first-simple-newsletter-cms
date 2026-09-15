import { PERMISSIONS } from "../constants/permissions.js";

export function authorize(resource, action) {
  return (req, res, next) => {
    if (!req.user) {
      return req.path.startsWith("/api")
        ? res.status(401).json({ error: res.locals.t("api.auth.authRequired") })
        : res.status(401).render("error", { message: res.locals.t("api.auth.authRequired") });
    }

    if (req.user.role === "superadmin") return next();

    const rolePerms = PERMISSIONS[req.user.role];
    if (!rolePerms || !rolePerms[resource]?.[action]) {
      return req.path.startsWith("/api")
        ? res.status(403).json({ error: res.locals.t("api.auth.permissionDenied") })
        : res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }

    next();
  };
}
