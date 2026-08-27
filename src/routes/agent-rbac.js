import { canAccessSite, requireAgent } from "./agent-helpers.js";
import { auditLog } from "../services/audit.js";
import {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  assignUserRole,
  listShifts,
  createShift,
  updateShift,
  deleteShift,
  onDutyUsers,
  searchAuditLog,
} from "../services/rbac.js";

// ─────────────────────────────────────────────────────────────────────────
// Route agent F28: ruoli custom (RBAC granulare), turni operatori, ricerca
// audit. Registrate con registerRbacRoutes(router) sullo stesso router
// agent di crm-agent.js (requireAuth+requireAgent già applicati lì a livello
// di mount /api/agent — qui ogni route ripete solo requireAgent per parità
// di stile con crm-agent.js).
// ─────────────────────────────────────────────────────────────────────────

const userIdOf = (req) => req.user?.id ?? req.user?.sub ?? null;

function handleError(err, res, next) {
  if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
  next(err);
}

export function registerRbacRoutes(router) {
  // ── Ruoli custom ───────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/roles", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const roles = await listRoles(siteId);
      res.json({ roles });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/roles", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const name = String(req.body.name || "").trim().slice(0, 255);
      if (!name) return res.status(400).json({ error: "Nome obbligatorio" });
      const role = await createRole(siteId, { name, permissions: req.body.permissions });
      await auditLog({
        userId: userIdOf(req), siteId, entityType: "custom_role", entityId: role.id,
        action: "role_create", newData: { name: role.name, permissions: role.permissions },
        ipAddress: req.ip,
      });
      res.json({ role });
    } catch (err) { handleError(err, res, next); }
  });

  router.put("/api/agent/sites/:siteId/roles/:roleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const roleId = parseInt(req.params.roleId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const role = await updateRole(siteId, roleId, {
        name: req.body.name,
        permissions: req.body.permissions,
      });
      await auditLog({
        userId: userIdOf(req), siteId, entityType: "custom_role", entityId: role.id,
        action: "role_update", newData: { name: role.name, permissions: role.permissions },
        ipAddress: req.ip,
      });
      res.json({ role });
    } catch (err) { handleError(err, res, next); }
  });

  router.delete("/api/agent/sites/:siteId/roles/:roleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const roleId = parseInt(req.params.roleId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await deleteRole(siteId, roleId);
      await auditLog({
        userId: userIdOf(req), siteId, entityType: "custom_role", entityId: roleId,
        action: "role_delete", oldData: { id: roleId }, ipAddress: req.ip,
      });
      res.json(result);
    } catch (err) { handleError(err, res, next); }
  });

  // ── Assegnazione ruolo a un utente del sito ────────────────────────────

  router.put("/api/agent/sites/:siteId/users/:userId/role", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const raw = req.body.custom_role_id;
      const roleId = (raw === null || raw === undefined || raw === "") ? null : parseInt(raw, 10);
      if (raw !== null && raw !== undefined && raw !== "" && !Number.isInteger(roleId)) {
        return res.status(400).json({ error: "custom_role_id non valido" });
      }
      const user = await assignUserRole(siteId, req.params.userId, roleId);
      await auditLog({
        userId: userIdOf(req), siteId, entityType: "user", entityId: user.id,
        action: "role_assign", newData: { custom_role_id: roleId }, ipAddress: req.ip,
      });
      res.json({ user });
    } catch (err) { handleError(err, res, next); }
  });

  // ── Turni operatori ────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/shifts", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const shifts = await listShifts(siteId);
      res.json({ shifts });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/shifts", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const shift = await createShift(siteId, {
        user_id: req.body.user_id,
        day_of_week: req.body.day_of_week,
        start_min: req.body.start_min,
        end_min: req.body.end_min,
      });
      await auditLog({
        userId: userIdOf(req), siteId, entityType: "operator_shift", entityId: shift.id,
        action: "shift_create", newData: shift, ipAddress: req.ip,
      });
      res.json({ shift });
    } catch (err) { handleError(err, res, next); }
  });

  router.put("/api/agent/sites/:siteId/shifts/:shiftId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const shiftId = parseInt(req.params.shiftId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const shift = await updateShift(siteId, shiftId, {
        user_id: req.body.user_id,
        day_of_week: req.body.day_of_week,
        start_min: req.body.start_min,
        end_min: req.body.end_min,
        active: req.body.active,
      });
      await auditLog({
        userId: userIdOf(req), siteId, entityType: "operator_shift", entityId: shift.id,
        action: "shift_update", newData: shift, ipAddress: req.ip,
      });
      res.json({ shift });
    } catch (err) { handleError(err, res, next); }
  });

  router.delete("/api/agent/sites/:siteId/shifts/:shiftId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const shiftId = parseInt(req.params.shiftId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await deleteShift(siteId, shiftId);
      await auditLog({
        userId: userIdOf(req), siteId, entityType: "operator_shift", entityId: shiftId,
        action: "shift_delete", oldData: { id: shiftId }, ipAddress: req.ip,
      });
      res.json(result);
    } catch (err) { handleError(err, res, next); }
  });

  // ── Operatori in turno e ricerca audit ─────────────────────────────────

  router.get("/api/agent/sites/:siteId/operators-on-duty", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const operators = await onDutyUsers(siteId, req.query.date ? new Date(req.query.date) : new Date());
      res.json({ operators });
    } catch (err) { next(err); }
  });

  router.get("/api/agent/sites/:siteId/audit-events", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await searchAuditLog(siteId, {
        user_id: req.query.user_id,
        action: req.query.action,
        entity_type: req.query.entity_type,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json(result);
    } catch (err) { next(err); }
  });
}
