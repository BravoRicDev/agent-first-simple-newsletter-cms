import { Router } from "express";
import { sendError, sendList, requireAnyId, getPaging, getLocationId } from "./_helpers.js";
import * as tagsService from "../../services/tags.js";
import { findByAnyId } from "../../services/external-ids.js";
import { serializeTag, serializeTagList } from "../../serializers/tag.js";

// Onda A — Tag per-tenant: CRUD root-level /tags.
// Contratto: docs/API_CLONE_MASTER_PLAN.md §5 onda A.

const router = Router();

// GET /tags - Lista tag con paginazione
router.get("/tags", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);

    const { rows, total, nextStartAfterId } = await tagsService.listTags(
      req.tenant.siteId,
      { limit, startAfterId }
    );

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeTagList(rows, locationId);
    sendList(res, "tags", serialized, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// POST /tags - Crea nuovo tag
router.post("/tags", async (req, res, next) => {
  try {
    const { name, color } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return sendError(res, 400, "Nome richiesto");
    }

    const row = await tagsService.createTag(req.tenant.siteId, {
      name: name.trim(),
      color: color || null,
    });

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeTag(row, locationId);
    res.status(201).json({ tag: serialized });
  } catch (err) {
    if (err.status === 409 || err.code === 409) {
      return sendError(res, 409, "Tag già esistente");
    }
    next(err);
  }
});

// GET /tags/:id - Ottieni tag per uuid esterno
router.get("/tags/:id", async (req, res, next) => {
  try {
    const externalId = requireAnyId(req.params.id, res);
    if (!externalId) return;

    const row = await findByAnyId("tags", req.tenant.siteId, externalId);
    if (!row) {
      return sendError(res, 404, "Tag non trovato");
    }

    if (row.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Tag non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeTag(row, locationId);
    res.json({ tag: serialized });
  } catch (err) {
    if (err.status === 400) {
      return sendError(res, 400, err.message || "Identificatore non valido");
    }
    next(err);
  }
});

// PUT /tags/:id - Aggiorna tag
router.put("/tags/:id", async (req, res, next) => {
  try {
    const externalId = requireAnyId(req.params.id, res);
    if (!externalId) return;

    const row = await findByAnyId("tags", req.tenant.siteId, externalId);
    if (!row) {
      return sendError(res, 404, "Tag non trovato");
    }

    if (row.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Tag non trovato");
    }

    const { name, color } = req.body;
    const updated = await tagsService.updateTag(req.tenant.siteId, row.id, {
      name: name !== undefined ? name.trim() : undefined,
      color,
    });

    if (!updated) {
      return sendError(res, 404, "Tag non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeTag(updated, locationId);
    res.json({ tag: serialized });
  } catch (err) {
    if (err.status === 400) {
      return sendError(res, 400, err.message || "Identificatore non valido");
    }
    if (err.status === 409 || err.code === 409) {
      return sendError(res, 409, "Tag già esistente");
    }
    next(err);
  }
});

// DELETE /tags/:id - Elimina tag
router.delete("/tags/:id", async (req, res, next) => {
  try {
    const externalId = requireAnyId(req.params.id, res);
    if (!externalId) return;

    const row = await findByAnyId("tags", req.tenant.siteId, externalId);
    if (!row) {
      return sendError(res, 404, "Tag non trovato");
    }

    if (row.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Tag non trovato");
    }

    const deleted = await tagsService.deleteTag(req.tenant.siteId, row.id);
    if (!deleted) {
      return sendError(res, 404, "Tag non trovato");
    }

    res.json({ deleted: true });
  } catch (err) {
    if (err.status === 400) {
      return sendError(res, 400, err.message || "Identificatore non valido");
    }
    next(err);
  }
});

export default router;
