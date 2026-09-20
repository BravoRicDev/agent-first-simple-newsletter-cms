import { Router } from "express";
import { query } from "../../db.js";
import { sendError, sendList, requireUuid, getPaging, getLocationId, requireAnyId, buildMeta } from "./_helpers.js";
import * as customFieldsService from "../../services/custom-fields.js";
import * as customFieldFoldersService from "../../services/custom-field-folders.js";
import { findByExternalId, findByAnyId } from "../../services/external-ids.js";
import { serializeCustomField, serializeCustomFieldList, serializeCustomValue, serializeCustomFieldGhlList } from "../../serializers/custom-field.js";
import { serializeFolder, serializeFolderList } from "../../serializers/custom-field-folder.js";
import { publicId } from "../../services/external-ids.js";
import { resolveSiteInternalId } from "../../services/agency-clone.js";
import { recordComparison, isPassthroughActive } from "../../services/ghl-parity.js";
import { logger } from "../../services/logger.js";

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

// ─── Custom Fields — GHL-true ───────────────────────────────────────────

// GET /locations/:locationId/customFields — endpoint REALE di GHL (verificato
// dal vivo, vedi DIVERGENZA-CUSTOM-FIELDS.md e services/source-sync/mappers/
// custom-fields.js:57-67): UNA chiamata sola, nessuna paginazione, locationId
// SOLO nel path. Il :locationId può essere l'UUID interno del site o il
// location_external_id reale — stessa risoluzione già in uso da
// GET /locations/:locationId (users.js, Onda G), nessun controllo aggiuntivo
// contro il tenant autenticato: stesso comportamento agency-style già
// stabilito per l'intera famiglia di risorse /locations/:locationId/*.
const CUSTOM_FIELDS_PARITY_ENDPOINT = "GET /locations/:locationId/customFields";

// Confronto specifico per la shape dei custom field (shadow-verifica, vedi
// services/ghl-parity.js): id + fieldKey + dataType devono coincidere per
// tutti i campi (stesso conteggio, stesso contenuto sostanziale).
// dataType GHL intenzionalmente NON rappresentabili 1:1 nel nostro schema
// locale (vedi serializers/custom-field.js e mappers/custom-fields.js):
// PHONE/MONETORY/EMAIL restano "text" per approssimazione voluta,
// MULTIPLE_OPTIONS/TEXTBOX_LIST/FILE_UPLOAD non hanno un tipo locale
// equivalente. Per questi il confronto dataType va SEMPRE saltato — non è
// una vera divergenza, è un limite noto e accettato del clone: altrimenti
// l'endpoint non potrebbe MAI raggiungere il passthrough su nessun account
// che usa questi tipi, pur essendo fedele su tutto ciò che rappresentiamo
// davvero.
const APPROXIMATED_GHL_DATATYPES = new Set([
  "PHONE", "MONETORY", "EMAIL", "MULTIPLE_OPTIONS", "TEXTBOX_LIST", "FILE_UPLOAD",
]);

// Esportata solo per test unitari mirati (test/source-sync/
// custom-fields-datatype-fix.test.js) — il resto del modulo la usa in
// locale via scheduleCustomFieldsParityCheck.
export function compareCustomFieldsLists(clonePayload, ghlPayload) {
  const ghlFields = ghlPayload?.customFields || ghlPayload || [];
  if (clonePayload.length === 0 && ghlFields.length === 0) {
    return { equivalent: false, skipReason: "both_empty" };
  }
  if (clonePayload.length !== ghlFields.length) {
    return { equivalent: false, skipReason: null };
  }
  const key = (f) => String(f.id || "");
  const sortedClone = [...clonePayload].sort((a, b) => key(a).localeCompare(key(b)));
  const sortedGhl = [...ghlFields].sort((a, b) => key(a).localeCompare(key(b)));
  for (let i = 0; i < sortedClone.length; i++) {
    const c = sortedClone[i];
    const g = sortedGhl[i];
    if (key(c) !== key(g)) return { equivalent: false, skipReason: null };
    if ((c.fieldKey || "") !== (g.fieldKey || "")) return { equivalent: false, skipReason: null };
    if (!APPROXIMATED_GHL_DATATYPES.has(String(g.dataType || "").toUpperCase())) {
      if ((c.dataType || "") !== (g.dataType || "")) return { equivalent: false, skipReason: null };
    }
  }
  return { equivalent: true, skipReason: null };
}

// Shadow-verifica fire-and-forget: MAI await-ata dal chiamante. Usa
// cfg.location_id (l'id REALE di GHL da source_sync_config), non il
// :locationId ricevuto in richiesta — potrebbe essere l'UUID interno.
function scheduleCustomFieldsParityCheck(siteId, locationIdForLog, serializedFields) {
  isPassthroughActive(siteId, CUSTOM_FIELDS_PARITY_ENDPOINT)
    .then((active) => {
      if (active) return;
      return recordComparison({
        siteId,
        endpoint: CUSTOM_FIELDS_PARITY_ENDPOINT,
        requestKey: String(locationIdForLog),
        clonePayload: serializedFields,
        isEquivalent: compareCustomFieldsLists,
        fetchReal: async () => {
          const { loadConfig, createSourceClient } = await import("../../services/source-sync/client.js");
          const cfg = await loadConfig(siteId);
          if (!cfg || !cfg.enabled) throw new Error("source-sync non configurato");
          const client = createSourceClient(cfg);
          return client.get(`/locations/${cfg.location_id}/customFields`, {}, { sendLocationId: false });
        },
      });
    })
    .catch((err) => logger.error(`scheduleCustomFieldsParityCheck fallita (site ${siteId}): ${err.message}`));
}

router.get("/locations/:locationId/customFields", async (req, res, next) => {
  try {
    const siteId = await resolveSiteInternalId(req.params.locationId);
    if (!siteId) {
      return sendError(res, 404, "Location non trovata");
    }

    // model=all|contact|opportunity: GHL reale rifiuta il parametro su altri
    // endpoint (vedi doc), ma qui è il NOSTRO filtro locale — liberale,
    // "all"/assente/valore sconosciuto = nessun filtro (contact+opportunity
    // insieme, come la risposta reale).
    const model = String(req.query.model || "").toLowerCase();
    const objectKey = model === "contact" || model === "opportunity" ? model : null;

    const rows = await customFieldsService.listCustomFields(siteId, { objectKey });
    const serialized = serializeCustomFieldGhlList(rows, req.params.locationId);
    if (!objectKey) {
      // Shadow-verifica solo sulla chiamata NON filtrata: è l'unica verificata
      // 1:1 contro il comportamento reale di GHL (DIVERGENZA-CUSTOM-FIELDS.md) —
      // il filtro model=contact/opportunity è un filtro NOSTRO, non del sorgente.
      scheduleCustomFieldsParityCheck(siteId, req.params.locationId, serialized);
    }
    res.json({ customFields: serialized });
  } catch (err) {
    next(err);
  }
});

// ─── Custom Fields — alias legacy ────────────────────────────────────────
// NON GHL-true (path/paginazione/shape inventati): mantenuto solo perché
// crm-v2/src/services/cms.js:223-236 lo consuma già così. La rotta GHL-true
// da usare per la parità con GHL reale è quella sopra.

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
      const idx = all.findIndex((r) => r.external_id === startAfterId || (r.source_id && r.source_id === startAfterId));
      startIndex = idx >= 0 ? idx + 1 : 0;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const lastRow = page[page.length - 1];
    const nextStartAfterId = startIndex + limit < total ? (lastRow ? publicId(lastRow) : null) : null;

    const locationId = await getLocationId(req.tenant);
    const serialized = serializeCustomFieldList(page, locationId);

    // Round 18: sorgente serve i CUSTOM VALUES dentro la STESSA risposta di
    // GET /customFields/ (chiave `customValues`, sempre presente anche se
    // vuota): https://marketplace.example.com/docs/source/custom-fields/custom-fields
    // La tabella source_custom_values è il mirror del sorgente (mapper
    // "custom-values"): nessun external_id proprio → id = source_id reale.
    // Nessun cursore per i valori: sorgente li restituisce tutti in una lista
    // (volumi tipici: decine, mai osservata paginazione sul sorgente).
    const valueRows = (await query(
      "SELECT source_id, name, value FROM source_custom_values WHERE site_id = $1 ORDER BY id ASC",
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

// GET /custom-fields/:id - Ottieni custom field per uuid esterno o source_id
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
