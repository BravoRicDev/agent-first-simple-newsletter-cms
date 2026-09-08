// ─────────────────────────────────────────────────────────────────────────
// Onda G: Users, Teams, Locations (Agencies) — Clone API endpoints
// Root-level sulle risorse: /locations, /users, /teams (onda G).
// ─────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import {
  createLocation,
  getLocationByIdOrExternalId,
  updateLocationBusinessInfo,
  createUser,
  getUsersByLocationId,
  getUserById,
  updateUser,
  deleteUser,
  searchUsersByEmail,
  createTeam,
  getTeamsByLocationId,
  getTeamById,
  updateTeam,
  deleteTeam,
} from "../../services/agency-clone.js";
import { sendError, requireUuid, isValidUuid, getPaging, sendList, getLocationId } from "./_helpers.js";
import { findByExternalId } from "../../services/external-ids.js";

const router = Router();

// ── LOCATIONS ────────────────────────────────────────────────────────────

// POST /locations — crea nuova location (sub-account via API)
router.post("/locations", async (req, res, next) => {
  try {
    const { name, businessInfo } = req.body;

    if (!name) {
      return sendError(res, 400, "Nome location richiesto");
    }

    const location = await createLocation({ name, businessInfo });
    res.status(201).json({ location });
  } catch (err) {
    next(err);
  }
});

// GET /locations/{locationId} — recupera location per uuid esterno o location_external_id
router.get("/locations/:locationId", async (req, res, next) => {
  try {
    const { locationId } = req.params;

    const location = await getLocationByIdOrExternalId(locationId);
    if (!location) {
      return sendError(res, 404, "Location non trovata");
    }

    res.json({ location });
  } catch (err) {
    next(err);
  }
});

// PUT /locations/{locationId}/business-info — aggiorna business info
router.put("/locations/:locationId/business-info", async (req, res, next) => {
  try {
    const { locationId } = req.params;
    const { businessInfo } = req.body;

    const siteRow = await findByExternalId("sites", locationId);
    if (!siteRow) {
      return sendError(res, 404, "Location non trovata");
    }

    const location = await updateLocationBusinessInfo(siteRow.id, businessInfo || {});
    if (!location) {
      return sendError(res, 404, "Location non trovata");
    }

    res.json({ location });
  } catch (err) {
    next(err);
  }
});

// ── USERS ────────────────────────────────────────────────────────────────

// GET /users — lista utenti della location corrente
router.get("/users", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const { users, total, nextId } = await getUsersByLocationId(req.tenant.siteId, limit, startAfterId);

    const locationId = await getLocationId(req.tenant);
    const enriched = users.map((u) => ({ ...u, locationId }));

    sendList(res, "users", enriched, total, nextId);
  } catch (err) {
    next(err);
  }
});

// POST /users — crea nuovo utente
router.post("/users", async (req, res, next) => {
  try {
    const { firstName, lastName, email, roles } = req.body;

    if (!email) {
      return sendError(res, 400, "Email obbligatoria");
    }

    const user = await createUser({
      siteId: req.tenant.siteId,
      firstName: firstName || "",
      lastName: lastName || "",
      email,
      roles,
    });

    const locationId = await getLocationId(req.tenant);
    user.locationId = locationId;

    res.status(201).json({ user });
  } catch (err) {
    if (err.message && err.message.includes("duplicate key")) {
      return sendError(res, 409, "Email già in uso");
    }
    next(err);
  }
});

// GET /users/{userId} — recupera utente
router.post("/users/search", async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return sendError(res, 400, "Email obbligatoria");
    }

    const users = await searchUsersByEmail(req.tenant.siteId, email);
    const locationId = await getLocationId(req.tenant);
    const enriched = users.map((u) => ({ ...u, locationId }));

    res.json({ users: enriched });
  } catch (err) {
    next(err);
  }
});

router.get("/users/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!requireUuid(userId, res)) return;

    const userRow = await findByExternalId("users", userId);
    if (!userRow || userRow.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Utente non trovato");
    }

    const user = await getUserById(req.tenant.siteId, userRow.id);
    if (!user) {
      return sendError(res, 404, "Utente non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    user.locationId = locationId;

    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PUT /users/{userId} — aggiorna utente
router.put("/users/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!requireUuid(userId, res)) return;

    const userRow = await findByExternalId("users", userId);
    if (!userRow || userRow.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Utente non trovato");
    }

    const user = await updateUser(req.tenant.siteId, userRow.id, req.body);
    if (!user) {
      return sendError(res, 404, "Utente non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    user.locationId = locationId;

    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// DELETE /users/{userId} — cancella utente
router.delete("/users/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!requireUuid(userId, res)) return;

    const userRow = await findByExternalId("users", userId);
    if (!userRow || userRow.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Utente non trovato");
    }

    const deleted = await deleteUser(req.tenant.siteId, userRow.id);
    if (!deleted) {
      return sendError(res, 404, "Utente non trovato");
    }

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /users/search — cerca utenti per email
// ── TEAMS ────────────────────────────────────────────────────────────────

// GET /teams — lista team della location corrente
router.get("/teams", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const { teams, total, nextId } = await getTeamsByLocationId(req.tenant.siteId, limit, startAfterId);

    const locationId = await getLocationId(req.tenant);
    const enriched = teams.map((t) => ({ ...t, locationId }));

    sendList(res, "teams", enriched, total, nextId);
  } catch (err) {
    next(err);
  }
});

// POST /teams — crea nuovo team
router.post("/teams", async (req, res, next) => {
  try {
    const { name, members } = req.body;

    if (!name) {
      return sendError(res, 400, "Nome team obbligatorio");
    }

    const team = await createTeam({
      siteId: req.tenant.siteId,
      name,
      members,
    });

    const locationId = await getLocationId(req.tenant);
    team.locationId = locationId;

    res.status(201).json({ team });
  } catch (err) {
    next(err);
  }
});

// GET /teams/{id} — recupera team
router.get("/teams/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const team = await getTeamById(req.tenant.siteId, id);
    if (!team) {
      return sendError(res, 404, "Team non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    team.locationId = locationId;

    res.json({ team });
  } catch (err) {
    next(err);
  }
});

// PUT /teams/{id} — aggiorna team
router.put("/teams/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const team = await updateTeam(req.tenant.siteId, id, req.body);
    if (!team) {
      return sendError(res, 404, "Team non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    team.locationId = locationId;

    res.json({ team });
  } catch (err) {
    next(err);
  }
});

// DELETE /teams/{id} — cancella team
router.delete("/teams/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const deleted = await deleteTeam(req.tenant.siteId, id);
    if (!deleted) {
      return sendError(res, 404, "Team non trovato");
    }

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
