import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireUuid, getPaging, sendList, getLocationId,
} from "./_helpers.js";
import * as productsClone from "../../services/products-clone.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda H: Products — clone API, prezzi inline, paginazione cursore.
// Pattern: rotte statiche PRIMA dei :param.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

router.get("/products", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const result = await productsClone.listProducts(req.tenant.siteId, { limit, startAfterId }, locationId);
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
    const id = requireUuid(req.params.id, res);
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
    const id = requireUuid(req.params.id, res);
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
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const count = await productsClone.deleteProduct(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Prodotto non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
