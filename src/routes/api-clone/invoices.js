import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireAnyId, getPaging, sendList, getLocationId,
} from "./_helpers.js";
import * as invoicesClone from "../../services/invoices-clone.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda H: Invoices — clone API, items inline, coupon come riga negativa.
// Pattern: rotte statiche PRIMA dei :param.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

router.get("/invoices", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const filters = {
      status: req.query.status,
      contactId: req.query.contactId,
      limit,
      startAfterId,
    };
    const result = await invoicesClone.listInvoices(req.tenant.siteId, filters, locationId);
    sendList(res, "invoices", result.invoices, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/invoices", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      contactId: req.body.contactId,
      items: req.body.items,
      dueDate: req.body.dueDate,
      notes: req.body.notes,
      couponCode: req.body.couponCode,
    };

    const invoice = await invoicesClone.createInvoice(req.tenant.siteId, input, locationId);
    res.status(201).json({ invoice });
  } catch (err) {
    next(err);
  }
});

router.get("/invoices/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const invoice = await invoicesClone.getInvoice(req.tenant.siteId, id, locationId);
    if (!invoice) return sendError(res, 404, "Fattura non trovata");
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

router.put("/invoices/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const input = {
      status: req.body.status,
      dueDate: req.body.dueDate,
      notes: req.body.notes,
    };

    const invoice = await invoicesClone.updateInvoice(req.tenant.siteId, id, input, locationId);
    if (!invoice) return sendError(res, 404, "Fattura non trovata");
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

router.delete("/invoices/:id", async (req, res, next) => {
  try {
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const count = await invoicesClone.deleteInvoice(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Fattura non trovata o non in draft");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
