import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireAnyId, getPaging, sendList, getLocationId,
} from "./_helpers.js";
import * as invoicesClone from "../../services/invoices-clone.js";
import { recordComparison, isPassthroughActive, compareGhlSubset } from "../../services/ghl-parity.js";
import { logger } from "../../services/logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda H: Invoices — clone API, items inline, coupon come riga negativa.
// Pattern: rotte statiche PRIMA dei :param.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

const INVOICES_PARITY_ENDPOINT = "GET /invoices";

// Shadow-verifica fire-and-forget (vedi services/ghl-parity.js). GET /invoices/
// reale legge SEMPRE solo la prima pagina (limit=100/offset=0, vedi
// mappers/commerce.js — nessuna paginazione reale, stesso limite accettato
// dal sync stesso): stesso identico limite qui, nessuna estensione oltre
// quanto già fa il sync periodico.
function scheduleInvoicesParityCheck(siteId, serializedInvoices) {
  isPassthroughActive(siteId, INVOICES_PARITY_ENDPOINT)
    .then((active) => {
      if (active) return;
      return recordComparison({
        siteId,
        endpoint: INVOICES_PARITY_ENDPOINT,
        clonePayload: serializedInvoices,
        isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => (Array.isArray(p) ? p : p?.invoices || []) }),
        fetchReal: async () => {
          const { loadConfig, createSourceClient } = await import("../../services/source-sync/client.js");
          const cfg = await loadConfig(siteId);
          if (!cfg || !cfg.enabled) throw new Error("source-sync non configurato");
          const client = createSourceClient(cfg);
          return client.get("/invoices/", { altId: cfg.location_id, altType: "location", limit: "100", offset: "0" });
        },
      });
    })
    .catch((err) => logger.error(`scheduleInvoicesParityCheck fallita (site ${siteId}): ${err.message}`));
}

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
    // Shadow-verifica solo sulla lista COMPLETA e non filtrata (nessun
    // status/contactId, nessun cursore): i filtri sono NOSTRI, non del
    // sorgente, un confronto su una lista filtrata fallirebbe sempre.
    if (!req.query.status && !req.query.contactId && !startAfterId && !result.nextStartAfterId) {
      scheduleInvoicesParityCheck(req.tenant.siteId, result.invoices);
    }
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
