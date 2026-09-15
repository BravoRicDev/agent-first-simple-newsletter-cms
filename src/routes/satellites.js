import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { auditLog } from "../services/audit.js";
import {
  listSatellites, createSatellite, updateSatellite, deleteSatellite, setSatelliteAgentToken,
} from "../services/satellites.js";

// ─────────────────────────────────────────────────────────────────────────
// Admin UI del registro moduli satellite (SSO): allowlist degli origin che
// possono ricevere il redirect_uri post-login + capability dichiarate
// (discovery/proxy/eventi tra satelliti).
//
// Accesso: solo superadmin (in aggiunta al permesso settings/update, perché
// il registro decide dove atterrano gli utenti dopo il login).
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

function requireSuperadminPage(req, res, next) {
  if (req.user?.role !== "superadmin") {
    return res.status(403).render("error", { message: res.locals.t("api.common.forbidden") });
  }
  next();
}

// Il form invia capabilities come testo JSON: parse + validazione server-side.
function parseJsonArrayField(raw, label) {
  const text = String(raw || "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("json_invalid");
    err.code = "SATELLITE_JSON_INVALID";
    err.message = `${label}: JSON non valido.`;
    throw err;
  }
}

function friendlyError(err) {
  switch (err.code) {
    case "SATELLITE_JSON_INVALID": return err.message;
    case "SATELLITE_INVALID_ORIGIN": return "Origin non valida: usa un URL completo http(s)://…";
    case "SATELLITE_INVALID_CAPABILITIES": return "Capability non valide: ogni voce richiede method (GET/POST/…), path che inizia con \"/\" e scope read|write.";
    case "SATELLITE_INVALID_WEBHOOKS": return "Webhook non validi: servono event e url.";
    case "SATELLITE_INVALID_BASE_INTERNAL": return "base_internal non valido: usa un URL http(s)://… (es. http://nome-container:3103).";
    case "SATELLITE_INVALID_USER_ID": return "User ID non valido: inserisci un numero o lascia vuoto.";
    default: return null;
  }
}

async function applyAgentToken(req, satelliteId) {
  const raw = req.body.agent_token;
  if (raw === undefined) return;
  await setSatelliteAgentToken(satelliteId, String(raw).trim() || null);
}

router.get("/admin/satellites", requireAuth, authorize("settings", "read"), requireSuperadminPage, async (req, res, next) => {
  try {
    const satellites = await listSatellites();
    res.render("admin/satellites/index", { satellites });
  } catch (err) { next(err); }
});

router.post("/admin/satellites", requireAuth, authorize("settings", "update"), requireSuperadminPage, async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const origin = String(req.body.origin || "").trim();
    const enabled = req.body.enabled === "on" || req.body.enabled === "true";
    if (!name || !origin) {
      return res.status(400).render("error", { message: "Nome e origin sono obbligatori." });
    }
    const payload = {
      name,
      origin,
      enabled,
      capabilities: parseJsonArrayField(req.body.capabilities, "Capabilities"),
      webhooks: parseJsonArrayField(req.body.webhooks, "Webhooks"),
    };
    if (String(req.body.base_internal || "").trim()) payload.base_internal = String(req.body.base_internal).trim();
    if (String(req.body.user_id || "").trim() !== "") payload.user_id = req.body.user_id;
    const satellite = await createSatellite(payload);
    await applyAgentToken(req, satellite.id);
    await auditLog({
      userId: req.user.sub, siteId: null,
      entityType: "satellite", entityId: satellite.id, action: "create",
      newData: {
        name: satellite.name, origin: satellite.origin, enabled: satellite.enabled,
        capabilities_count: (satellite.capabilities || []).length,
        base_internal: satellite.base_internal, user_id: satellite.user_id,
        agent_token_set: satellite.has_agent_token,
      },
      ipAddress: req.ip,
    });
    res.redirect("/admin/satellites");
  } catch (err) {
    const msg = friendlyError(err);
    if (msg) return res.status(400).render("error", { message: msg });
    next(err);
  }
});

router.post("/admin/satellites/:id/update", requireAuth, authorize("settings", "update"), requireSuperadminPage, async (req, res, next) => {
  try {
    const current = await listSatellites();
    const sat = current.find((s) => s.id === parseInt(req.params.id, 10));
    if (!sat) return res.status(404).render("error", { message: "Satellite non trovato." });
    const payload = {};
    if (String(req.body.name || "").trim()) payload.name = String(req.body.name).trim();
    if (String(req.body.origin || "").trim()) payload.origin = String(req.body.origin).trim();
    if (req.body.enabled !== undefined) payload.enabled = req.body.enabled === "on" || req.body.enabled === "true";
    if (req.body.capabilities !== undefined && String(req.body.capabilities).trim() !== "") {
      payload.capabilities = JSON.parse(String(req.body.capabilities));
    }
    if (req.body.base_internal !== undefined) payload.base_internal = String(req.body.base_internal).trim();
    if (req.body.user_id !== undefined) payload.user_id = String(req.body.user_id).trim() === "" ? null : req.body.user_id;
    const satellite = Object.keys(payload).length > 0 ? await updateSatellite(sat.id, payload) : sat;
    await applyAgentToken(req, sat.id);
    await auditLog({
      userId: req.user.sub, siteId: null,
      entityType: "satellite", entityId: sat.id, action: "update",
      oldData: { name: sat.name, origin: sat.origin, enabled: sat.enabled },
      newData: {
        name: satellite.name, origin: satellite.origin, enabled: satellite.enabled,
        base_internal: satellite.base_internal, user_id: satellite.user_id,
      },
      ipAddress: req.ip,
    });
    res.redirect("/admin/satellites");
  } catch (err) {
    const msg = friendlyError(err);
    if (msg) return res.status(400).render("error", { message: msg });
    next(err);
  }
});

router.post("/admin/satellites/:id/toggle", requireAuth, authorize("settings", "update"), requireSuperadminPage, async (req, res, next) => {
  try {
    const current = (await listSatellites()).find((s) => s.id === parseInt(req.params.id, 10));
    if (!current) return res.status(404).render("error", { message: "Satellite non trovato." });
    const satellite = await updateSatellite(current.id, { enabled: !current.enabled });
    await auditLog({
      userId: req.user.sub, siteId: null,
      entityType: "satellite", entityId: current.id, action: "update",
      oldData: { enabled: !satellite.enabled },
      newData: { enabled: satellite.enabled },
      ipAddress: req.ip,
    });
    res.redirect("/admin/satellites");
  } catch (err) { next(err); }
});

router.post("/admin/satellites/:id/delete", requireAuth, authorize("settings", "update"), requireSuperadminPage, async (req, res, next) => {
  try {
    const current = (await listSatellites()).find((s) => s.id === parseInt(req.params.id, 10));
    if (!current) return res.status(404).render("error", { message: "Satellite non trovato." });
    const deleted = await deleteSatellite(current.id);
    await auditLog({
      userId: req.user.sub, siteId: null,
      entityType: "satellite", entityId: deleted.id, action: "delete",
      oldData: { name: deleted.name, origin: deleted.origin },
      ipAddress: req.ip,
    });
    res.redirect("/admin/satellites");
  } catch (err) { next(err); }
});

export default router;
