import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { requireModule } from "../middleware/modules.js";
import { getPipelineBoard, setContactStage, upsertContact } from "../services/contacts.js";
import { PIPELINE_STAGES, PIPELINE_STAGE_KEYS } from "../constants/pipeline.js";

const router = Router();

router.get("/admin/pipeline", requireAuth, authorize("forms", "read"), requireModule("sales_pipeline"), async (req, res, next) => {
  try {
    const board = await getPipelineBoard(req.moduleSiteId);
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    res.render("admin/pipeline/index", { board, stages: PIPELINE_STAGES, siteId: req.moduleSiteId, sites, isSuperadmin });
  } catch (err) { next(err); }
});

router.post("/admin/pipeline/new", requireAuth, authorize("forms", "update"), requireModule("sales_pipeline"), async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).render("error", { message: "Email non valida." });
    }
    await upsertContact(req.moduleSiteId, email);
    await setContactStage(req.moduleSiteId, email, "lead");
    res.redirect(`/admin/pipeline?site_id=${req.moduleSiteId}`);
  } catch (err) { next(err); }
});

router.post("/admin/pipeline/:email/stage", requireAuth, authorize("forms", "update"), requireModule("sales_pipeline"), async (req, res, next) => {
  try {
    // req.params.email arriva dall'URL: validarlo come il campo email di /new
    // (prima finiva direttamente in upsertContact → inquinamento dati e
    // possibili errori DB su email oltre il limite varchar).
    const email = String(req.params.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).render("error", { message: "Email non valida." });
    }
    const stage = req.body.stage || "";
    // stage="" è un valore di reset legittimo? No: setContactStage con stringa
    // vuota sovrascriverebbe lo status. Rifiuta anche la stringa vuota.
    if (!PIPELINE_STAGE_KEYS.has(stage)) {
      return res.status(400).render("error", { message: "Stadio sconosciuto." });
    }
    await setContactStage(req.moduleSiteId, email, stage);
    res.redirect(`/admin/pipeline?site_id=${req.moduleSiteId}`);
  } catch (err) { next(err); }
});

export default router;
