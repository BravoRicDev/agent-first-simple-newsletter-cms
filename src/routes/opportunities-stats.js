import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { searchOpportunities, getRevenueStats, getConversionFunnel, getVendorStats, getTrend, reassignOpportunityOwner } from "../services/opportunities-stats.js";

const router = Router();

router.get("/api/opportunities/search", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10) : req.user.site_id;
    res.json(await searchOpportunities(siteId, { q: req.query.q, limit: req.query.limit, offset: req.query.offset }));
  } catch (err) { next(err); }
});

router.get("/api/opportunities/stats/revenue", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10) : req.user.site_id;
    res.json(await getRevenueStats(siteId, { pipelineId: req.query.pipeline_id }));
  } catch (err) { next(err); }
});

router.get("/api/opportunities/stats/conversion", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!req.query.pipeline_id) return res.status(400).json({ error: res.locals.t("api.common.invalidData") });
    const funnel = await getConversionFunnel(siteId, parseInt(req.query.pipeline_id, 10));
    if (!funnel) return res.status(404).json({ error: res.locals.t("api.common.pageNotFound") });
    res.json({ funnel });
  } catch (err) { next(err); }
});

router.get("/api/opportunities/stats/vendor", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10) : req.user.site_id;
    res.json({ vendors: await getVendorStats(siteId) });
  } catch (err) { next(err); }
});

router.get("/api/opportunities/stats/trend", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.query.site_id
      ? parseInt(req.query.site_id, 10) : req.user.site_id;
    res.json({ trend: await getTrend(siteId, { granularity: req.query.granularity, days: req.query.days ? parseInt(req.query.days, 10) : undefined }) });
  } catch (err) { next(err); }
});

router.put("/api/opportunities/:id/owner", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const siteId = req.user.role === "superadmin" && req.body.site_id
      ? parseInt(req.body.site_id, 10) : req.user.site_id;
    const schema = z.object({ vendor: z.string().min(1) });
    const parsed = schema.parse(req.body);
    const result = await reassignOpportunityOwner(siteId, req.params.id, parsed.vendor);
    if (!result) return res.status(404).json({ error: res.locals.t("api.common.pageNotFound") });
    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData") });
    if (err.message === "vendor_not_found") return res.status(404).json({ error: "vendor_not_found" });
    if (err.message === "vendor_ambiguous") return res.status(409).json({ error: "vendor_ambiguous", candidates: err.candidates });
    next(err);
  }
});

export default router;
