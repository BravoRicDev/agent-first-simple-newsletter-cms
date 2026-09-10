import { Router } from "express";
import { query } from "../../db.js";
import { sendError, sendList, requireUuid, getPaging, getLocationId, requireAnyId, buildMeta } from "./_helpers.js";
import * as customFieldsService from "../../services/custom-fields.js";
import * as customFieldFoldersService from "../../services/custom-field-folders.js";
import { findByExternalId, findByAnyId } from "../../services/external-ids.js";
import { serializeCustomField, serializeCustomFieldList, serializeCustomValue } from "../../serializers/custom-field.js";
import { serializeFolder, serializeFolderList } from "../../serializers/custom-field-folder.js";
import { publicId } from "../../services/external-ids.js";

// Onda A — Custom fields/values/folders clone.
// Contratto: docs/API_CLONE_MASTER_PLAN.md §5 onda A.

const router = Router();

const REVERSE_TYPE_MAP = {
  TEXT: "text",
  LARGE_TEXT: "textarea",
  NUMERIC: "number",
  DATE: "date",
  CHECKBOX: "checkbox",
  DROPDOWN: "select",
  RADIO: "radio",
};

// ─── Custom Fields ───────────────────────────────────────────────────────

// GET /custom-fields - Lista custom field con filtro objectKey opzionale
router.get("/custom-fields", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const objectKey = req.query.objectKey || "contact";

    // customFieldsService.listCustomFields ritorna un array piatto (contratto
    // già in uso da routes/v1.js, non modificabile qui senza romperlo):
    // niente limit/startAfterId lato query, paginazione fatta qui in memoria
    // sul cursore external_id (uuid) esposto dall'API clone — coerente con
    // D2 (docs/API_CLONE_MASTER_PLAN.md), volumi tipici bassi (decine/poche
    // centinaia di custom field per sito, mai osservata paginazione reale
    // lato CRM sorgente su questo endpoint, vedi mappers/custom-fields.js).
    const all = await customFieldsService.listCustomFields(req.tenant.siteId, { objectKey });
    const total = all.length;

    let startIndex = 0;
    if (startAfterId) {
      const idx = all.findIndex((r) => r.external_id === startAfterId || (r.ghl_id && r.ghl_id === startAfterId));
      startIndex = idx >= 0 ? idx + 1 : 0;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const lastRow = page[page.length - 1];
    const nextStartAfterId = startIndex + limit < total ? (lastRow ? publicId(lastRow) : null) : null;

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeCustomFieldList(page, locationId);

    // Round 18: GHL serve i CUSTOM VALUES dentro la STESSA risposta di
    // GET /customFields/ (chiave `customValues`, sempre presente anche se
    // vuota): https://marketplace.gohighlevel.com/docs/ghl/custom-fields/custom-fields
    // La tabella ghl_custom_values è il mirror del sorgente (mapper
    // "custom-values"): nessun external_id proprio → id = ghl_id reale.
    // Nessun cursore per i valori: GHL li restituisce tutti in una lista
    // (volumi tipici: decine, mai osservata paginazione sul sorgente).
    const valueRows = (await query(
      "SELECT ghl_id, name, value FROM ghl_custom_values WHERE site_id = $1 ORDER BY id ASC",
      [req.tenant.siteId]
    )).rows;

    res.json({
      customFields: serialized,
      customValues: valueRows.map(serializeCustomValue),
      meta: buildMeta(total, nextStartAfterId),
    });
  } catch (err) {
    next(err);
  }
});

// POST /custom-fields - Crea nuovo custom field
router.post("/custom-fields", async (req, res, next) => {
  try {
    const { name, dataType = "TEXT", objectKey = "contact", options = [] } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return sendError(res, 400, "Nome richiesto");
    }

    const internalType = REVERSE_TYPE_MAP[dataType];
    if (!internalType) {
      return sendError(res, 400, "DataType non valido");
    }

    const slug = (value) => {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100);
    };

    const fieldKey = slug(name);
    const optionsArray = Array.isArray(options) ? options : [];

    const row = await customFieldsService.createCustomField(req.tenant.siteId, {
      name: name.trim(),
      field_key: fieldKey,
      object_key: objectKey,
      type: internalType,
      options: optionsArray,
    });

    if (!row) {
      return sendError(res, 400, "Creazione custom field fallita");
    }

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeCustomField(row, locationId);
    res.status(201).json({ customField: serialized });
  } catch (err) {
    next(err);
  }
});

// ─── Custom Field Folders (PRIMA di /:id per priority matching) ───────────

// GET /custom-fields/folder - Lista folder
router.get("/custom-fields/folder", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);

    const { rows, total, nextStartAfterId } = await customFieldFoldersService.listFolders(
      req.tenant.siteId,
      { limit, startAfterId }
    );

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeFolderList(rows, locationId);
    sendList(res, "folders", serialized, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// POST /custom-fields/folder - Crea nuovo folder
router.post("/custom-fields/folder", async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return sendError(res, 400, "Nome richiesto");
    }

    const row = await customFieldFoldersService.createFolder(req.tenant.siteId, {
      name: name.trim(),
    });

    if (!row) {
      return sendError(res, 400, "Creazione folder fallita");
    }

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeFolder(row, locationId);
    res.status(201).json({ folder: serialized });
  } catch (err) {
    if (err.status === 409 || err.code === 409) {
      return sendError(res, 409, "Folder già esistente");
    }
    next(err);
  }
});

// DELETE /custom-fields/folder/:id - Elimina folder
router.delete("/custom-fields/folder/:id", async (req, res, next) => {
  try {
    const externalId = requireUuid(req.params.id, res);
    if (!externalId) return;

    const row = await customFieldFoldersService.getFolderByExternalId(
      req.tenant.siteId,
      externalId
    );
    if (!row) {
      return sendError(res, 404, "Folder non trovato");
    }

    const deleted = await customFieldFoldersService.deleteFolder(req.tenant.siteId, row.id);
    if (!deleted) {
      return sendError(res, 404, "Folder non trovato");
    }

    res.json({ deleted: true });
  } catch (err) {
    if (err.status === 400) {
      return sendError(res, 400, err.message || "Identificatore non valido");
    }
    next(err);
  }
});

// GET /custom-fields/:id - Ottieni custom field per uuid esterno o ghl_id
router.get("/custom-fields/:id", async (req, res, next) => {
  try {
    const externalId = requireAnyId(req.params.id, res);
    if (!externalId) return;

    const row = await findByAnyId("custom_fields", req.tenant.siteId, externalId);
    if (!row) {
      return sendError(res, 404, "Custom field non trovato");
    }

    if (row.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Custom field non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeCustomField(row, locationId);
    res.json({ customField: serialized });
  } catch (err) {
    if (err.status === 400) {
      return sendError(res, 400, err.message || "Identificatore non valido");
    }
    next(err);
  }
});

// PUT /custom-fields/:id - Aggiorna custom field
router.put("/custom-fields/:id", async (req, res, next) => {
  try {
    const externalId = requireAnyId(req.params.id, res);
    if (!externalId) return;

    const row = await findByAnyId("custom_fields", req.tenant.siteId, externalId);
    if (!row) {
      return sendError(res, 404, "Custom field non trovato");
    }

    if (row.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Custom field non trovato");
    }

    const { name, dataType, options } = req.body;

    let updateData = {};
    if (name !== undefined) {
      updateData.name = name;
    }
    if (dataType !== undefined) {
      const internalType = REVERSE_TYPE_MAP[dataType];
      if (!internalType) {
        return sendError(res, 400, "DataType non valido");
      }
      updateData.type = internalType;
    }
    if (options !== undefined) {
      updateData.options = Array.isArray(options) ? options : [];
    }

    const updated = await customFieldsService.updateCustomField(
      req.tenant.siteId,
      row.id,
      updateData
    );

    if (!updated) {
      return sendError(res, 404, "Custom field non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeCustomField(updated, locationId);
    res.json({ customField: serialized });
  } catch (err) {
    if (err.status === 400) {
      return sendError(res, 400, err.message || "Identificatore non valido");
    }
    next(err);
  }
});

// DELETE /custom-fields/:id - Elimina custom field
router.delete("/custom-fields/:id", async (req, res, next) => {
  try {
    const externalId = requireAnyId(req.params.id, res);
    if (!externalId) return;

    const row = await findByAnyId("custom_fields", req.tenant.siteId, externalId);
    if (!row) {
      return sendError(res, 404, "Custom field non trovato");
    }

    if (row.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Custom field non trovato");
    }

    const deleted = await customFieldsService.deleteCustomField(req.tenant.siteId, row.id);
    if (!deleted) {
      return sendError(res, 404, "Custom field non trovato");
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
