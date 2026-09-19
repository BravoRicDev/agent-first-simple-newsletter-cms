import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireAnyId, getPaging, sendList, getLocationId,
} from "./_helpers.js";
import * as productsClone from "../../services/products-clone.js";
import { recordComparison, isPassthroughActive, compareGhlSubset } from "../../services/ghl-parity.js";
import { logger } from "../../services/logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda H: Products — clone API, prezzi inline, paginazione cursore.
// Pattern: rotte statiche PRIMA dei :param.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

const PRODUCTS_PARITY_ENDPOINT = "GET /products";

// Shadow-verifica fire-and-forget (vedi services/ghl-parity.js): solo sulla
// pagina completa (nessun cursore), stesso motivo di tags.js.
function scheduleProductsParityCheck(siteId, serializedProducts) {
  isPassthroughActive(siteId, PRODUCTS_PARITY_ENDPOINT)
    .then((active) => {
      if (active) return;
      return recordComparison({
        siteId,
        endpoint: PRODUCTS_PARITY_ENDPOINT,
        clonePayload: serializedProducts,
        // CRM sorgente espone l'id prodotto come _id O id a seconda della
        // versione (vedi mappers/commerce.js: product._id || product.id) —
        // compareGhlSubset prova già id poi _id di default, nessun override.
        isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => (Array.isArray(p) ? p : p?.products || []) }),
        fetchReal: async () => {
          const { loadConfig, createSourceClient } = await import("../../services/source-sync/client.js");
          const cfg = await loadConfig(siteId);
          if (!cfg || !cfg.enabled) throw new Error("source-sync non configurato");
          const client = createSourceClient(cfg);
          return client.get("/products/", { locationId: cfg.location_id });
        },
      });
    })
    .catch((err) => logger.error(`scheduleProductsParityCheck fallita (site ${siteId}): ${err.message}`));
}

router.get("/products", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const result = await productsClone.listProducts(req.tenant.siteId, { limit, startAfterId }, locationId);
    if (!startAfterId && !result.nextStartAfterId) {
      scheduleProductsParityCheck(req.tenant.siteId, result.products);
    }
    sendList(res, "products", result.products, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/products", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      name: req.body.name,
      description: req.body.description,
      type: req.body.type,
      prices: req.body.prices,
    };

    const product = await productsClone.createProduct(req.tenant.siteId, input, locationId);
    res.status(201).json({ product });
  } catch (err) {
    next(err);
  }
});

router.get("/products/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const product = await productsClone.getProduct(req.tenant.siteId, id, locationId);
    if (!product) return sendError(res, 404, "Prodotto non trovato");
    res.json({ product });
  } catch (err) {
    next(err);
  }
});

router.put("/products/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const input = {
      name: req.body.name,
      description: req.body.description,
      type: req.body.type,
      prices: req.body.prices,
    };

    const product = await productsClone.updateProduct(req.tenant.siteId, id, input, locationId);
    if (!product) return sendError(res, 404, "Prodotto non trovato");
    res.json({ product });
  } catch (err) {
    next(err);
  }
});

router.delete("/products/:id", async (req, res, next) => {
  try {
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const count = await productsClone.deleteProduct(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Prodotto non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
