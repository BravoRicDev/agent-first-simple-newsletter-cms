import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { auditLog } from "../services/audit.js";

const router = Router();

function sameSite(targetSiteId, actorSiteId) {
  return targetSiteId != null && actorSiteId != null && targetSiteId === actorSiteId;
}

// setter/closer: account di servizio per il modulo satellite collego-sales
// (SSO + API dati). Nessun permesso admin (authorize e' deny-by-default).
const userSchema = z.object({
  email: z.string().email(),
  name: z.string().optional().default(""),
  surname: z.string().optional().default(""),
  role: z.enum(["admin", "collaboratore", "setter", "closer"]),
  site_id: z.string().optional(),
});

router.get("/admin/users", requireAuth, authorize("users", "read"), async (req, res, next) => {
  try {
    let result;
    if (req.user.role === "superadmin") {
      result = await query(
        `SELECT u.id, u.email, u.name, u.surname, u.role, u.status, u.site_id, s.name AS site_name
         FROM users u LEFT JOIN sites s ON s.id = u.site_id ORDER BY u.email`
      );
    } else {
      result = await query(
        `SELECT u.id, u.email, u.name, u.surname, u.role, u.status, u.site_id, s.name AS site_name
         FROM users u LEFT JOIN sites s ON s.id = u.site_id
         WHERE u.site_id = $1 ORDER BY u.email`,
        [req.user.site_id]
      );
    }
    res.render("admin/users/index", { users: result.rows, currentUserId: req.user.sub });
  } catch (err) { next(err); }
});

router.get("/admin/users/new", requireAuth, authorize("users", "create"), async (req, res, next) => {
  try {
    let sites;
    if (req.user.role === "superadmin") {
      sites = (await query("SELECT id, name FROM sites ORDER BY name")).rows;
    } else {
      sites = (await query("SELECT id, name FROM sites WHERE id = $1", [req.user.site_id])).rows;
    }
    res.render("admin/users/new", { sites });
  } catch (err) { next(err); }
});

router.post("/admin/users", requireAuth, authorize("users", "create"), async (req, res, next) => {
  try {
    const data = userSchema.parse(req.body);
    // Email normalizzata (lowercase/trim): prima "User@X.com" e "user@x.com"
    // erano account distinti (il vincolo 23505 non scattava) e il login con
    // case diverso falliva silenziosamente.
    const email = String(data.email || "").trim().toLowerCase();
    const siteId = req.user.role === "superadmin" ? (data.site_id ? parseInt(data.site_id, 10) : null) : req.user.site_id;
    const inserted = await query(
      "INSERT INTO users (email, name, surname, role, site_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [email, data.name, data.surname, data.role, siteId]
    );
    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "user", entityId: inserted.rows[0].id, action: "create",
      newData: { email, role: data.role, site_id: siteId },
      ipAddress: req.ip,
    });
    res.redirect("/admin/users");
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).render("error", { message: res.locals.t("api.common.invalidData") });
    if (err.code === "23505") return res.status(400).render("error", { message: res.locals.t("api.users.emailExists") });
    next(err);
  }
});

router.get("/admin/users/:id/edit", requireAuth, authorize("users", "update"), async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.common.userNotFound") });
    if (req.user.role !== "superadmin" && !sameSite(result.rows[0].site_id, req.user.site_id)) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const sites = req.user.role === "superadmin"
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : (await query("SELECT id, name FROM sites WHERE id = $1", [req.user.site_id])).rows;
    res.render("admin/users/edit", { user: result.rows[0], sites, viewerRole: req.user.role });
  } catch (err) { next(err); }
});

router.post("/admin/users/:id", requireAuth, authorize("users", "update"), async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const result = await query("SELECT site_id, role, status FROM users WHERE id = $1", [targetId]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.common.userNotFound") });
    const before = result.rows[0];
    if (req.user.role !== "superadmin" && !sameSite(before.site_id, req.user.site_id)) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    const { name, surname, role, status } = req.body;
    const allowedRoles = req.user.role === "superadmin"
      ? ["admin", "collaboratore", "superadmin", "setter", "closer"]
      : ["admin", "collaboratore", "setter", "closer"];
    if (!allowedRoles.includes(role)) {
      return res.status(403).render("error", { message: res.locals.t("api.users.invalidRole") });
    }
    const allowedStatuses = ["active", "disabled"];
    const safeStatus = allowedStatuses.includes(status) ? status : "active";

    // Il site_id non è mai preso dal body per un admin non-superadmin: viene sempre
    // forzato al proprio sito, altrimenti un admin potrebbe riassegnare un utente
    // (o se stesso) a un sito che non gestisce.
    let finalSiteId;
    if (req.user.role === "superadmin") {
      const rawSiteId = req.body.site_id;
      finalSiteId = rawSiteId ? parseInt(rawSiteId, 10) : null;
      if (finalSiteId !== null) {
        const siteCheck = await query("SELECT id FROM sites WHERE id = $1", [finalSiteId]);
        if (siteCheck.rows.length === 0) {
          return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
        }
      }
    } else {
      finalSiteId = req.user.site_id;
    }

    if (targetId === req.user.sub && (safeStatus !== "active" || role !== before.role)) {
      return res.status(400).render("error", { message: res.locals.t("api.users.cannotLockSelfOut") });
    }

    const changed = before.role !== role || before.site_id !== finalSiteId || before.status !== safeStatus;

    await query(
      `UPDATE users SET name = $1, surname = $2, role = $3, site_id = $4, status = $5, updated_at = NOW()${changed ? ", token_version = token_version + 1" : ""} WHERE id = $6`,
      [name || "", surname || "", role, finalSiteId, safeStatus, targetId]
    );
    if (changed) {
      await auditLog({
        userId: req.user.sub, siteId: finalSiteId ?? before.site_id,
        entityType: "user", entityId: targetId, action: "update",
        oldData: { role: before.role, site_id: before.site_id, status: before.status },
        newData: { role, site_id: finalSiteId, status: safeStatus },
        ipAddress: req.ip,
      });
    }
    res.redirect("/admin/users");
  } catch (err) { next(err); }
});

router.post("/admin/users/:id/delete", requireAuth, authorize("users", "delete"), async (req, res, next) => {
  try {
    const result = await query("SELECT site_id, email, role FROM users WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).render("error", { message: res.locals.t("api.common.userNotFound") });
    if (req.user.role !== "superadmin" && !sameSite(result.rows[0].site_id, req.user.site_id)) {
      return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
    }
    if (parseInt(req.params.id, 10) === req.user.sub) {
      return res.status(400).render("error", { message: res.locals.t("api.users.cannotDeleteSelf") });
    }
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    await auditLog({
      userId: req.user.sub, siteId: result.rows[0].site_id,
      entityType: "user", entityId: parseInt(req.params.id, 10), action: "delete",
      oldData: { email: result.rows[0].email, role: result.rows[0].role },
      ipAddress: req.ip,
    });
    res.redirect("/admin/users");
  } catch (err) { next(err); }
});

export default router;
