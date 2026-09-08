import { Router } from "express";
import {
  listMediaFiles,
  getMediaFile,
  registerMediaFile,
  updateMediaFile,
  deleteMediaFile,
  serializeMediaFile,
} from "../../services/media-files-clone.js";
import { getLocationId, sendError, sendList, getPaging, requireUuid } from "./_helpers.js";

const router = Router();

// GET /files — lista file registrati del tenant, con paginazione
router.get("/files", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);

    const { files: rows, total, nextStartAfterId } = await listMediaFiles(req.tenant.siteId, {
      limit,
      startAfterId,
    });

    const files = rows.map((f) => serializeMediaFile(f, locationId));
    sendList(res, "files", files, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// POST /files/register — registra un file GIÀ in storage
router.post("/files/register", async (req, res, next) => {
  try {
    const { url, filename, mimeType, sizeBytes, alt } = req.body;

    if (!url || !filename) {
      return sendError(res, 400, "url e filename obbligatori");
    }

    const locationId = await getLocationId(req.tenant);
    const row = await registerMediaFile(req.tenant.siteId, {
      url,
      filename,
      mimeType: mimeType || null,
      sizeBytes: sizeBytes || 0,
      alt: alt || "",
    });

    if (!row) {
      return sendError(res, 400, "Registrazione file fallita");
    }

    const file = serializeMediaFile(row, locationId);
    res.status(201).json({ file });
  } catch (err) {
    next(err);
  }
});

// GET /files/:fileId — leggi un file specifico
router.get("/files/:fileId", async (req, res, next) => {
  try {
    const fileId = requireUuid(req.params.fileId, res);
    if (!fileId) return;

    const locationId = await getLocationId(req.tenant);
    const row = await getMediaFile(req.tenant.siteId, fileId);

    if (!row) {
      return sendError(res, 404, "File non trovato");
    }

    const file = serializeMediaFile(row, locationId);
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

// PUT /files/:fileId — aggiorna alt
router.put("/files/:fileId", async (req, res, next) => {
  try {
    const fileId = requireUuid(req.params.fileId, res);
    if (!fileId) return;

    const { alt } = req.body;
    const locationId = await getLocationId(req.tenant);

    const row = await updateMediaFile(req.tenant.siteId, fileId, { alt });
    if (!row) {
      return sendError(res, 404, "File non trovato");
    }

    const file = serializeMediaFile(row, locationId);
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

// DELETE /files/:fileId — elimina dal registro (non tocca filesystem)
router.delete("/files/:fileId", async (req, res, next) => {
  try {
    const fileId = requireUuid(req.params.fileId, res);
    if (!fileId) return;

    const deleted = await deleteMediaFile(req.tenant.siteId, fileId);
    if (!deleted) {
      return sendError(res, 404, "File non trovato");
    }

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
