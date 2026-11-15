import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resetMfa } from "../services/mfa.js";

const router = Router();
const sessionOnly = (req, res, next) => (req.user?.agent || req.user?.api_token ? res.status(403).json({ error: "session_required" }) : next());

router.get("/admin/security", requireAuth, sessionOnly, (req, res) => res.render("admin/security/index", { enroll: req.query.enroll === "1" }));

// Reset 2FA di un altro utente (dispositivo perso): admin del SUO sito o superadmin; solo un superadmin puo' resettare un superadmin.
router.post("/admin/api/users/:id/mfa-reset", requireAuth, sessionOnly, async (req, res, next) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "forbidden" });
    const id = /^\d+$/.test(req.params.id) ? parseInt(req.params.id, 10) : 0;
    const target = id ? (await query("SELECT id, role, site_id FROM users WHERE id = $1", [id])).rows[0] : null;
    if (!target) return res.status(404).json({ error: "not_found" });
    if (req.user.role !== "superadmin" && (target.site_id !== req.user.site_id || target.role === "superadmin")) return res.status(404).json({ error: "not_found" });
    await resetMfa(target.id, req.user);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

export default router;
