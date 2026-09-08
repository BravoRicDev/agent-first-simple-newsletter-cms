import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireUuid, getPaging, buildMeta, sendList, getLocationId,
} from "./_helpers.js";
import * as formsClone from "../../services/forms-clone.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda C: Router forms — contratto camelCase, UUID esterni,
// paginazione cursore. Submissions CRUD con linkage form_id/contact_id.
// Nota: /forms/submissions rotta STATICA deve venire PRIMA di /forms/:id.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// ── Form definitions ─────────────────────────────────────────────────────

router.get("/forms", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const filters = {
      q: req.query.q,
      limit,
      startAfterId,
    };
    const result = await formsClone.listForms(req.tenant.siteId, filters, locationId);
    sendList(res, "forms", result.forms, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/forms", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const name = req.body.name || "";

    if (!name.trim()) return sendError(res, 400, "Nome del modulo obbligatorio");

    const form = await formsClone.createForm(req.tenant.siteId, name, locationId);
    if (!form) return sendError(res, 400, "Impossibile creare modulo");
    res.status(201).json({ form });
  } catch (err) {
    next(err);
  }
});

// ── Submissions (rotta STATICA — prima del param) ─────────────────────────

router.get("/forms/submissions", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);

    // Risolvi formIds (CSV di uuid)
    let formIds = [];
    if (req.query.formIds) {
      formIds = req.query.formIds.split(",").map(s => s.trim()).filter(s => s);
      for (const id of formIds) {
        if (!isValidUuid(id)) return sendError(res, 400, "FormId non valido");
      }
    }

    const filters = {
      formIds,
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
      limit,
      startAfterId,
    };

    const result = await formsClone.listSubmissions(req.tenant.siteId, filters, locationId);
    sendList(res, "submissions", result.submissions, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// ── Form details (rotte parametriche) ────────────────────────────────────

router.get("/forms/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const form = await formsClone.getForm(req.tenant.siteId, id, locationId);
    if (!form) return sendError(res, 404, "Modulo non trovato");
    res.json({ form });
  } catch (err) {
    next(err);
  }
});

router.put("/forms/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const input = {
      name: req.body.name,
    };

    const form = await formsClone.updateForm(req.tenant.siteId, id, input, locationId);
    if (!form) return sendError(res, 404, "Modulo non trovato");
    res.json({ form });
  } catch (err) {
    next(err);
  }
});

router.delete("/forms/:id", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const count = await formsClone.deleteForm(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Modulo non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
