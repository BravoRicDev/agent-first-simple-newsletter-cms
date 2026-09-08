import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireUuid, getPaging, buildMeta, sendList, getLocationId,
} from "./_helpers.js";
import * as opportunitiesClone from "../../services/opportunities-clone.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda A: Router opportunities — contratto camelCase, UUID esterni,
// paginazione cursore, serializzazione stage/contactEmail.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// ── Opportunità ──────────────────────────────────────────────────────────

router.get("/opportunities", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const filters = {
      pipelineId: req.query.pipelineId,
      pipelineStageId: req.query.pipelineStageId,
      status: req.query.status,
      contactId: req.query.contactId,
      q: req.query.q,
      limit,
      startAfterId,
    };
    const result = await opportunitiesClone.listOpportunities(req.tenant.siteId, filters, locationId);
    sendList(res, "opportunities", result.opportunities, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/opportunities", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      name: req.body.name || req.body.title,
      pipelineId: req.body.pipelineId,
      pipelineStageId: req.body.pipelineStageId,
      status: req.body.status || "open",
      monetaryValue: req.body.monetaryValue !== undefined ? req.body.monetaryValue : req.body.amount,
      contactId: req.body.contactId,
      assignedTo: req.body.assignedTo,
      source: req.body.source,
    };

    const opp = await opportunitiesClone.createOpportunity(req.tenant.siteId, input, locationId);
    if (!opp) return sendError(res, 400, "Impossibile creare opportunità");
    res.status(201).json({ opportunity: opp });
  } catch (err) {
    next(err);
  }
});

// ── Lost reasons ─────────────────────────────────────────────────────────
// NB: registrata PRIMA di /opportunities/:id, altrimenti Express cattura
// "lost-reason" come :id e risponde 400 uuid non valido.

router.get("/opportunities/lost-reason", async (req, res, next) => {
  try {
    const reasons = await opportunitiesClone.getLostReasons(req.tenant.siteId);
    res.json({ lostReasons: reasons });
  } catch (err) {
    next(err);
  }
});


router.post("/opportunities/search", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const filters = {
      pipelineId: req.body.pipelineId || req.body.filters?.pipelineId,
      pipelineStageId: req.body.pipelineStageId || req.body.filters?.pipelineStageId,
      status: req.body.status || req.body.filters?.status,
      contactId: req.body.contactId || req.body.filters?.contactId,
      q: req.body.q || req.body.filters?.q,
      limit: req.body.limit || 20,
      startAfterId: req.body.startAfterId || req.body.filters?.startAfterId,
    };

    const result = await opportunitiesClone.searchOpportunities(req.tenant.siteId, filters, locationId);
    sendList(res, "opportunities", result.opportunities, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/opportunities/upsert", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      contactId: req.body.contactId,
      name: req.body.name || req.body.title,
      pipelineId: req.body.pipelineId,
      pipelineStageId: req.body.pipelineStageId,
      status: req.body.status,
      monetaryValue: req.body.monetaryValue !== undefined ? req.body.monetaryValue : req.body.amount,
      assignedTo: req.body.assignedTo,
      source: req.body.source,
    };

    const result = await opportunitiesClone.upsertOpportunity(req.tenant.siteId, input, locationId);
    if (!result?.opportunity) return sendError(res, 400, "Impossibile upsert opportunità");

    res.status(result.created ? 201 : 200).json({ opportunity: result.opportunity });
  } catch (err) {
    next(err);
  }
});

router.get("/opportunities/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const opp = await opportunitiesClone.getOpportunity(req.tenant.siteId, id, locationId);
    if (!opp) return sendError(res, 404, "Opportunità non trovata");
    res.json({ opportunity: opp });
  } catch (err) {
    next(err);
  }
});

router.put("/opportunities/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const input = {
      name: req.body.name,
      pipelineId: req.body.pipelineId,
      pipelineStageId: req.body.pipelineStageId,
      status: req.body.status,
      monetaryValue: req.body.monetaryValue !== undefined ? req.body.monetaryValue : req.body.amount,
      contactId: req.body.contactId,
      assignedTo: req.body.assignedTo,
      source: req.body.source,
      lostReason: req.body.lostReason,
    };

    const opp = await opportunitiesClone.updateOpportunity(req.tenant.siteId, id, input, locationId);
    if (!opp) return sendError(res, 404, "Opportunità non trovata");
    res.json({ opportunity: opp });
  } catch (err) {
    next(err);
  }
});

router.delete("/opportunities/:id", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const count = await opportunitiesClone.deleteOpportunity(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Opportunità non trovata");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

router.put("/opportunities/:id/status", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const status = req.body.status;
    if (!status) return sendError(res, 400, "Status mancante");

    const opp = await opportunitiesClone.setOpportunityStatus(req.tenant.siteId, id, status, locationId);
    if (!opp) return sendError(res, 404, "Opportunità non trovata o status non valido");
    res.json({ opportunity: opp });
  } catch (err) {
    next(err);
  }
});

// ── Followers ────────────────────────────────────────────────────────────

router.get("/opportunities/:id/followers", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const followers = await opportunitiesClone.listOpportunityFollowers(req.tenant.siteId, id);
    res.json({ followers });
  } catch (err) {
    next(err);
  }
});

router.post("/opportunities/:id/followers", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const userId = req.body.userId;
    if (!userId || !isValidUuid(userId)) return sendError(res, 400, "userId non valido");

    const follower = await opportunitiesClone.addOpportunityFollower(req.tenant.siteId, id, userId);
    if (!follower) return sendError(res, 404, "Opportunità o utente non trovato");
    res.status(201).json({ follower });
  } catch (err) {
    next(err);
  }
});

router.delete("/opportunities/:id/followers/:userId", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;
    const userId = requireUuid(req.params.userId, res);
    if (!userId) return;

    const count = await opportunitiesClone.removeOpportunityFollower(req.tenant.siteId, id, userId);
    if (!count) return sendError(res, 404, "Follower non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ── Pipelines ────────────────────────────────────────────────────────────

router.get("/pipelines", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const pipelines = await opportunitiesClone.listPipelines(req.tenant.siteId, locationId);
    res.json({ pipelines, meta: buildMeta(pipelines.length) });
  } catch (err) {
    next(err);
  }
});

router.post("/pipelines", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      name: req.body.name,
      stages: req.body.stages || [],
    };

    const pipeline = await opportunitiesClone.createPipeline(req.tenant.siteId, input, locationId);
    if (!pipeline) return sendError(res, 400, "Impossibile creare pipeline");
    res.status(201).json({ pipeline });
  } catch (err) {
    next(err);
  }
});

router.get("/pipelines/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const pipeline = await opportunitiesClone.getPipeline(req.tenant.siteId, id, locationId);
    if (!pipeline) return sendError(res, 404, "Pipeline non trovata");
    res.json({ pipeline });
  } catch (err) {
    next(err);
  }
});

router.put("/pipelines/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const input = {
      name: req.body.name,
      stages: req.body.stages || [],
    };

    const pipeline = await opportunitiesClone.updatePipeline(req.tenant.siteId, id, input, locationId);
    if (!pipeline) return sendError(res, 404, "Pipeline non trovata");
    res.json({ pipeline });
  } catch (err) {
    next(err);
  }
});

router.delete("/pipelines/:id", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const count = await opportunitiesClone.deletePipeline(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Pipeline non trovata");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
