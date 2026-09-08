import { Router } from "express";
import {
  sendError, httpError, isValidUuid, requireUuid, getPaging, sendList, getLocationId,
} from "./_helpers.js";
import * as campaignsClone from "../../services/campaigns-clone.js";
import { query } from "../../db.js";
import { findByExternalId } from "../../services/external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda E: Campagne broadcast, templates, subscriptions — clone API.
// Pattern: rotte statiche (GET /templates, GET /campaigns) PRIMA di param.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// ── Campagne ─────────────────────────────────────────────────────────────

router.get("/campaigns", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const result = await campaignsClone.listCampaigns(req.tenant.siteId, { limit, startAfterId }, locationId);
    sendList(res, "campaigns", result.campaigns, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      name: req.body.name,
      subject: req.body.subject,
      content: req.body.content || req.body.htmlContent,
    };

    const campaign = await campaignsClone.createCampaign(req.tenant.siteId, input, locationId);
    res.status(201).json({ campaign });
  } catch (err) {
    next(err);
  }
});

router.get("/campaigns/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const campaign = await campaignsClone.getCampaign(req.tenant.siteId, id, locationId);
    if (!campaign) return sendError(res, 404, "Campagna non trovata");
    res.json({ campaign });
  } catch (err) {
    next(err);
  }
});

router.put("/campaigns/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const input = {
      subject: req.body.subject,
      content: req.body.content || req.body.htmlContent,
    };

    const campaign = await campaignsClone.updateCampaign(req.tenant.siteId, id, input, locationId);
    if (!campaign) return sendError(res, 404, "Campagna non trovata");
    res.json({ campaign });
  } catch (err) {
    next(err);
  }
});

router.delete("/campaigns/:id", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const count = await campaignsClone.deleteCampaign(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Campagna non trovata o non in draft");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

router.put("/campaigns/:id/schedule", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const scheduledAt = req.body.scheduledAt;
    if (!scheduledAt) return sendError(res, 400, "scheduledAt mancante");

    const campaign = await campaignsClone.scheduleCampaign(req.tenant.siteId, id, scheduledAt, locationId);
    if (!campaign) return sendError(res, 404, "Campagna non trovata");
    res.json({ campaign });
  } catch (err) {
    next(err);
  }
});

router.post("/campaigns/:id/unschedule", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const campaign = await campaignsClone.unscheduleCampaign(req.tenant.siteId, id, locationId);
    if (!campaign) return sendError(res, 404, "Campagna non trovata");
    res.json({ campaign });
  } catch (err) {
    next(err);
  }
});

router.post("/campaigns/:id/send", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const campaign = await campaignsClone.sendCampaignNow(req.tenant.siteId, id, locationId);
    if (!campaign) return sendError(res, 404, "Campagna non trovata o non in draft/scheduled");
    res.json({ ok: true, status: campaign.status });
  } catch (err) {
    next(err);
  }
});

router.get("/campaigns/:id/stats", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const campaign = await findByExternalId("newsletter_campaigns", id);
    if (!campaign || campaign.site_id !== req.tenant.siteId) {
      return sendError(res, 404, "Campagna non trovata");
    }

    // Unico dato realmente derivabile dallo schema: i destinatari iscritti.
    // Nessuna tabella di tracking delivery/open/click esiste (nessun hook
    // provider li popola), quindi quei contatori restano a zero invece di
    // inventare numeri — "statistics base" (docs/API_COMPAT.md).
    const recipientCount = parseInt((await query(
      "SELECT COUNT(*)::int AS cnt FROM campaign_subscriptions WHERE campaign_id = $1 AND site_id = $2 AND status = 'active'",
      [campaign.id, req.tenant.siteId]
    )).rows[0]?.cnt || 0, 10);

    res.json({
      stats: {
        campaignId: id,
        status: campaign.status,
        recipientCount,
        deliveredCount: 0,
        openCount: 0,
        clickCount: 0,
        bouncedCount: 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Template ─────────────────────────────────────────────────────────────
// Statico PRIMA di :id

router.get("/templates", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const { limit, startAfterId } = getPaging(req.query);
    const result = await campaignsClone.listTemplates(
      req.tenant.siteId,
      { type: req.query.type, limit, startAfterId },
      locationId
    );
    sendList(res, "templates", result.templates, result.total, result.nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

router.post("/templates", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const input = {
      name: req.body.name,
      type: req.body.type,
      subject: req.body.subject,
      bodyHtml: req.body.bodyHtml,
    };

    const template = await campaignsClone.createTemplate(req.tenant.siteId, input, locationId);
    res.status(201).json({ template });
  } catch (err) {
    next(err);
  }
});

router.get("/templates/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const template = await campaignsClone.getTemplate(req.tenant.siteId, id, locationId);
    if (!template) return sendError(res, 404, "Template non trovato");
    res.json({ template });
  } catch (err) {
    next(err);
  }
});

router.put("/templates/:id", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const input = {
      name: req.body.name,
      type: req.body.type,
      subject: req.body.subject,
      bodyHtml: req.body.bodyHtml,
    };

    const template = await campaignsClone.updateTemplate(req.tenant.siteId, id, input, locationId);
    if (!template) return sendError(res, 404, "Template non trovato");
    res.json({ template });
  } catch (err) {
    next(err);
  }
});

router.delete("/templates/:id", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, res);
    if (!id) return;

    const count = await campaignsClone.deleteTemplate(req.tenant.siteId, id);
    if (!count) return sendError(res, 404, "Template non trovato");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ── Subscriptions (sotto /contacts/:contactId) ──────────────────────────
// Statiche PRIMA di :campaignId (removeAll prima del param)

router.get("/contacts/:contactId/campaigns", async (req, res, next) => {
  try {
    const locationId = await getLocationId(req.tenant);
    const contactId = requireUuid(req.params.contactId, res);
    if (!contactId) return;

    const result = await campaignsClone.listContactCampaigns(req.tenant.siteId, contactId, locationId);
    sendList(res, "campaigns", result.campaigns, result.meta.total);
  } catch (err) {
    next(err);
  }
});

router.post("/contacts/:contactId/campaigns/:campaignId", async (req, res, next) => {
  try {
    const contactId = requireUuid(req.params.contactId, res);
    if (!contactId) return;
    const campaignId = requireUuid(req.params.campaignId, res);
    if (!campaignId) return;

    const subscription = await campaignsClone.addContactToCampaign(
      req.tenant.siteId,
      contactId,
      campaignId
    );
    if (!subscription) return sendError(res, 404, "Contatto o campagna non trovati");
    res.status(201).json({ subscription });
  } catch (err) {
    next(err);
  }
});

router.delete("/contacts/:contactId/campaigns/removeAll", async (req, res, next) => {
  try {
    const contactId = requireUuid(req.params.contactId, res);
    if (!contactId) return;

    const removed = await campaignsClone.removeAllContactCampaigns(req.tenant.siteId, contactId);
    res.json({ removed });
  } catch (err) {
    next(err);
  }
});

router.delete("/contacts/:contactId/campaigns/:campaignId", async (req, res, next) => {
  try {
    const contactId = requireUuid(req.params.contactId, res);
    if (!contactId) return;
    const campaignId = requireUuid(req.params.campaignId, res);
    if (!campaignId) return;

    const count = await campaignsClone.removeContactFromCampaign(
      req.tenant.siteId,
      contactId,
      campaignId
    );
    if (!count) return sendError(res, 404, "Subscription non trovata");
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
