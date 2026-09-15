import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { listBugReports, listMyBugReports, createBugReport, getBugReport, updateBugReport } from "../services/bug-reports.js";

const router = Router();

const createSchema = z.object({
  categoria: z.string().optional().default(""),
  description: z.string().min(1),
  browser_info: z.string().optional().default(""),
  steps_to_reproduce: z.string().optional().default(""),
  expected_behavior: z.string().optional().default(""),
  actual_behavior: z.string().optional().default(""),
  mockup_before_html: z.string().optional().default(""),
  mockup_after_html: z.string().optional().default(""),
});

const updateSchema = z.object({
  status: z.enum(["aperto", "in_lavorazione", "risolto", "chiuso"]).optional(),
  priority: z.enum(["bassa", "normale", "alta", "critica"]).optional(),
  note_sviluppatore: z.string().optional(),
});

router.get("/api/bug-reports", requireAuth, authorize("bugReports", "read"), async (req, res, next) => {
  try {
    const { status, priority, limit = 50, offset = 0 } = req.query;
    res.json(await listBugReports({ status, priority, limit, offset }));
  } catch (err) { next(err); }
});

// Self-service: il possessore del token/sessione vede SOLO le proprie segnalazioni (nessun
// authorize("bugReports")), utile per un'integrazione esterna che vuole sapere se un ticket
// aperto è stato risolto. Deve stare PRIMA di "/api/bug-reports/:id" altrimenti Express
// interpreta "mine" come un :id.
router.get("/api/bug-reports/mine", requireAuth, async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    res.json(await listMyBugReports(req.user.sub, { status, limit, offset }));
  } catch (err) { next(err); }
});

router.post("/api/bug-reports", requireAuth, async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    res.json(await createBugReport(req.user, data));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData") });
    next(err);
  }
});

router.get("/api/bug-reports/:id", requireAuth, authorize("bugReports", "read"), async (req, res, next) => {
  try {
    const report = await getBugReport(req.params.id);
    if (!report) return res.status(404).json({ error: res.locals.t("api.bugReports.notFound") });
    res.json(report);
  } catch (err) { next(err); }
});

router.put("/api/bug-reports/:id", requireAuth, authorize("bugReports", "update"), async (req, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    const result = await updateBugReport(req.params.id, data);
    if (result.notFound) return res.status(404).json({ error: res.locals.t("api.bugReports.notFound") });
    if (result.noFields) return res.status(400).json({ error: res.locals.t("api.bugReports.noFieldsToUpdate") });
    res.json(result.updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: res.locals.t("api.common.invalidData") });
    next(err);
  }
});

export default router;
