import { Router } from "express";
import {
  listObjectDefinitions,
  getObjectDefinition,
  createObjectDefinition,
  updateObjectDefinition,
  deleteObjectDefinition,
  getObjectDefinitionByKey,
  listObjectRecords,
  getObjectRecord,
  createObjectRecord,
  updateObjectRecord,
  deleteObjectRecord,
  listAssociations,
  createAssociation,
  deleteAssociation,
  serializeObjectDefinition,
  serializeObjectRecord,
  serializeAssociation,
} from "../../services/objects-clone.js";
import { getLocationId, sendError, sendList, getPaging, requireUuid } from "./_helpers.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Object Definitions
// ─────────────────────────────────────────────────────────────────────────

// GET /objects — lista definizioni di oggetti custom
router.get("/objects", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);

    const { objectDefinitions: rows, total, nextStartAfterId } = await listObjectDefinitions(
      req.tenant.siteId,
      { limit, startAfterId }
    );

    const objectDefinitions = rows.map((d) => serializeObjectDefinition(d, locationId));
    sendList(res, "objectDefinitions", objectDefinitions, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// POST /objects — crea nuova definizione
router.post("/objects", async (req, res, next) => {
  try {
    const { objectKey, pluralLabel, primaryField } = req.body;

    if (!objectKey) {
      return sendError(res, 400, "objectKey obbligatorio");
    }

    const locationId = await getLocationId(req.tenant);
    const row = await createObjectDefinition(req.tenant.siteId, {
      objectKey,
      pluralLabel: pluralLabel || null,
      primaryField: primaryField || "name",
    });

    if (!row) {
      return sendError(res, 400, "Creazione definizione fallita");
    }

    const objectDefinition = serializeObjectDefinition(row, locationId);
    res.status(201).json({ objectDefinition });
  } catch (err) {
    next(err);
  }
});

// GET /objects/:definitionId — leggi una definizione
router.get("/objects/:definitionId", async (req, res, next) => {
  try {
    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    const locationId = await getLocationId(req.tenant);
    const row = await getObjectDefinition(req.tenant.siteId, definitionId);

    if (!row) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const objectDefinition = serializeObjectDefinition(row, locationId);
    res.json({ objectDefinition });
  } catch (err) {
    next(err);
  }
});

// PUT /objects/:definitionId — aggiorna una definizione
router.put("/objects/:definitionId", async (req, res, next) => {
  try {
    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    const { pluralLabel, primaryField } = req.body;
    const locationId = await getLocationId(req.tenant);

    const row = await updateObjectDefinition(req.tenant.siteId, definitionId, {
      pluralLabel,
      primaryField,
    });

    if (!row) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const objectDefinition = serializeObjectDefinition(row, locationId);
    res.json({ objectDefinition });
  } catch (err) {
    next(err);
  }
});

// DELETE /objects/:definitionId — elimina una definizione (cascata su record)
router.delete("/objects/:definitionId", async (req, res, next) => {
  try {
    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    const deleted = await deleteObjectDefinition(req.tenant.siteId, definitionId);
    if (!deleted) {
      return sendError(res, 404, "Definizione non trovata");
    }

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Object Records
// ─────────────────────────────────────────────────────────────────────────

// GET /objects/:definitionId/records — lista record di un oggetto
router.get("/objects/:definitionId/records", async (req, res, next) => {
  try {
    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    // Trova la definizione per confermare esiste
    const def = await getObjectDefinition(req.tenant.siteId, definitionId);
    if (!def) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);

    const result = await listObjectRecords(req.tenant.siteId, def.id, { limit, startAfterId });
    if (!result) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const { records: rows, total, nextStartAfterId } = result;
    const records = rows.map((r) => serializeObjectRecord(r, locationId, def.object_key));
    sendList(res, "records", records, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// POST /objects/:definitionId/records — crea nuovo record
router.post("/objects/:definitionId/records", async (req, res, next) => {
  try {
    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    const def = await getObjectDefinition(req.tenant.siteId, definitionId);
    if (!def) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const { data = {} } = req.body;

    const locationId = await getLocationId(req.tenant);
    const row = await createObjectRecord(req.tenant.siteId, def.id, data);

    if (!row) {
      return sendError(res, 400, "Creazione record fallita");
    }

    const record = serializeObjectRecord(row, locationId, def.object_key);
    res.status(201).json({ record });
  } catch (err) {
    next(err);
  }
});

// GET /objects/:definitionId/records/:recordId — leggi un record specifico
router.get("/objects/:definitionId/records/:recordId", async (req, res, next) => {
  try {
    const recordId = requireUuid(req.params.recordId, res);
    if (!recordId) return;

    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    const def = await getObjectDefinition(req.tenant.siteId, definitionId);
    if (!def) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const locationId = await getLocationId(req.tenant);
    const row = await getObjectRecord(req.tenant.siteId, recordId);

    if (!row || row.definition_id !== def.id) {
      return sendError(res, 404, "Record non trovato");
    }

    const record = serializeObjectRecord(row, locationId, def.object_key);
    res.json({ record });
  } catch (err) {
    next(err);
  }
});

// PUT /objects/:definitionId/records/:recordId — aggiorna record
router.put("/objects/:definitionId/records/:recordId", async (req, res, next) => {
  try {
    const recordId = requireUuid(req.params.recordId, res);
    if (!recordId) return;

    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    const def = await getObjectDefinition(req.tenant.siteId, definitionId);
    if (!def) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const { data = {} } = req.body;
    const locationId = await getLocationId(req.tenant);

    const row = await updateObjectRecord(req.tenant.siteId, recordId, data);
    if (!row) {
      return sendError(res, 404, "Record non trovato");
    }

    // Verifica ownership
    if (row.definition_id !== def.id) {
      return sendError(res, 404, "Record non trovato");
    }

    const record = serializeObjectRecord(row, locationId, def.object_key);
    res.json({ record });
  } catch (err) {
    next(err);
  }
});

// DELETE /objects/:definitionId/records/:recordId — elimina record
router.delete("/objects/:definitionId/records/:recordId", async (req, res, next) => {
  try {
    const recordId = requireUuid(req.params.recordId, res);
    if (!recordId) return;

    const definitionId = requireUuid(req.params.definitionId, res);
    if (!definitionId) return;

    const def = await getObjectDefinition(req.tenant.siteId, definitionId);
    if (!def) {
      return sendError(res, 404, "Definizione non trovata");
    }

    const deleted = await deleteObjectRecord(req.tenant.siteId, recordId);
    if (!deleted) {
      return sendError(res, 404, "Record non trovato");
    }

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Object Associations
// ─────────────────────────────────────────────────────────────────────────

// GET /objects/:definitionId/records/:recordId/associations — lista associazioni
router.get("/objects/:definitionId/records/:recordId/associations", async (req, res, next) => {
  try {
    const recordId = requireUuid(req.params.recordId, res);
    if (!recordId) return;

    const row = await getObjectRecord(req.tenant.siteId, recordId);
    if (!row) {
      return sendError(res, 404, "Record non trovato");
    }

    const relation = req.query.relation || null;
    const assocs = await listAssociations(req.tenant.siteId, recordId, { relation });

    if (!assocs) {
      return sendError(res, 404, "Record non trovato");
    }

    const associations = assocs.map(serializeAssociation);
    res.json({ associations });
  } catch (err) {
    next(err);
  }
});

// POST /objects/:definitionId/records/:recordId/associations — crea associazione
router.post("/objects/:definitionId/records/:recordId/associations", async (req, res, next) => {
  try {
    const recordId = requireUuid(req.params.recordId, res);
    if (!recordId) return;

    const { toRecordId, relation = "related" } = req.body;

    if (!toRecordId) {
      return sendError(res, 400, "toRecordId obbligatorio");
    }

    const row = await createAssociation(req.tenant.siteId, recordId, {
      toRecordId,
      relation,
    });

    if (!row) {
      return sendError(res, 400, "Creazione associazione fallita");
    }

    const association = serializeAssociation(row);
    res.status(201).json({ association });
  } catch (err) {
    next(err);
  }
});

// DELETE /objects/:definitionId/records/:recordId/associations/:toRecordId — elimina associazione
router.delete(
  "/objects/:definitionId/records/:recordId/associations/:toRecordId",
  async (req, res, next) => {
    try {
      const recordId = requireUuid(req.params.recordId, res);
      if (!recordId) return;

      const toRecordId = requireUuid(req.params.toRecordId, res);
      if (!toRecordId) return;

      const relation = req.query.relation || null;

      const deleted = await deleteAssociation(req.tenant.siteId, recordId, toRecordId, relation);
      if (!deleted) {
        return sendError(res, 404, "Associazione non trovata");
      }

      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
