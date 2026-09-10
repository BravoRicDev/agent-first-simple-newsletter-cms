import { Router } from "express";
import {
  sendError, httpError, requireAnyId, getPaging, sendList, getLocationId,
} from "./_helpers.js";
import * as surveysClone from "../../services/surveys-clone.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda D: Surveys — sondaggi multi-domanda con logica condizionale, risposte,
// submissions. Pattern: statici PRIMA di param. Contratto camelCase UUID.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// ── Sondaggi ─────────────────────────────────────────────────────────────

router.get("/surveys", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const result = await surveysClone.listSurveys(req.tenant.siteId, { limit, startAfterId }, locationId);
    sendList(res, "surveys", result.surveys, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/surveys", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      name: req.body.name,
      questions: req.body.questions,
    };

    const survey = await surveysClone.createSurvey(req.tenant.siteId, input, locationId);
    res.status(201).json({ survey });
  } catch (err) {
    next(err);
  }
});

router.get("/surveys/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const survey = await surveysClone.getSurvey(req.tenant.siteId, id, locationId);
    if (!survey) return sendError(res, 404, "Sondaggio non trovato");
    res.json({ survey });
  } catch (err) {
    next(err);
  }
});

router.put("/surveys/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const input = {
      name: req.body.name,
      status: req.body.status,
      questions: req.body.questions,
    };

    const survey = await surveysClone.updateSurvey(req.tenant.siteId, id, input, locationId);
    if (!survey) return sendError(res, 404, "Sondaggio non trovato");
    res.json({ survey });
  } catch (err) {
    next(err);
  }
});

router.delete("/surveys/:id", async (req, res, next) => {
  try {
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    const count = await surveysClone.deleteSurvey(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Sondaggio non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ── Risposte sondaggio ───────────────────────────────────────────────────

router.get("/surveys/:id/submissions", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    // Recupera l'id interno del survey tramite external_id o ghl_id reale
    const { findByAnyId } = await import("../../services/external-ids.js");
    const surveyRow = await findByAnyId("surveys", req.tenant.siteId, id);
    if (!surveyRow) {
      return sendError(res, 404, "Sondaggio non trovato");
    }

    const { limit, startAfterId } = getPaging(req.query);
    const result = await surveysClone.listSurveySubmissions(
      req.tenant.siteId,
      surveyRow.id,
      { limit, startAfterId },
      locationId
    );
    if (!result) return sendError(res, 404, "Sondaggio non trovato");
    sendList(res, "submissions", result.submissions, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/surveys/:id/submissions", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireAnyId(req.params.id, res);
    if (!id) return;

    // Recupera l'id interno del survey tramite external_id o ghl_id reale
    const { findByAnyId } = await import("../../services/external-ids.js");
    const surveyRow = await findByAnyId("surveys", req.tenant.siteId, id);
    if (!surveyRow) {
      return sendError(res, 404, "Sondaggio non trovato");
    }

    const input = {
      email: req.body.email,
      contactId: req.body.contactId,
      answers: req.body.answers || {},
    };

    const submission = await surveysClone.createSurveySubmission(
      req.tenant.siteId,
      surveyRow.id,
      input,
      locationId
    );
    if (!submission) return sendError(res, 404, "Sondaggio non trovato");
    res.status(201).json({ submission });
  } catch (err) {
    next(err);
  }
});

export default router;
