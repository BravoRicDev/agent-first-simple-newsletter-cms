import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { query } from "../db.js";
import { logger } from "../services/logger.js";
import {
  listRecordings, getRecording, createRecording, updateRecording,
  processRecording, reviewVerdict, weeklyCallMetrics,
  callMetricsWeeklyHistory, listRevisionQueue,
} from "../services/call-recordings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTECTED_ROOT = path.resolve(__dirname, "../../media-protected");
const CALLS_DIR = path.join(PROTECTED_ROOT, "calls");
fs.mkdirSync(CALLS_DIR, { recursive: true });

const router = Router();

// Rate limit sul processing (upload/valutazione) per evitare invio massivo
// di audio per gonfiare le metriche.
const processLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: (req, res) => ({ error: "Troppe richieste. Attendi qualche secondo." }),
  standardHeaders: true, legacyHeaders: false,
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CALLS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".mp3";
      const name = `${crypto.randomUUID()}${ext}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
  fileFilter: (req, file, cb) => {
    const allowed = [".mp3", ".wav", ".m4a", ".ogg", ".mp4", ".wma", ".aac", ".flac", ".opus", ".webm"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Formato non supportato: ${ext}`));
  },
});

// Carica la lista delle opportunità del sito (per scegliere a quale associare).
async function loadOpportunities(siteId) {
  return (await query(
    `SELECT o.id, o.title, o.contact_email, p.name AS pipeline_name
     FROM opportunities o
     LEFT JOIN pipelines p ON p.id = o.pipeline_id
     WHERE o.site_id = $1 ORDER BY o.updated_at DESC LIMIT 200`,
    [siteId]
  )).rows;
}

// ── Admin: elenco registrazioni ─────────────────────────────────────────
// Supporta ?review=1 per filtrare solo la coda di revisione (vedetto dubbia,
// M1) e ?verdict=si|no|dubbia per filtrare per esito.
router.get("/admin/call-recordings", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = req.moduleSiteId;
    const reviewQueue = req.query.review === "1";
    const recordings = reviewQueue
      ? await listRevisionQueue(siteId)
      : await listRecordings(siteId);
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    res.render("admin/call-recordings/index", {
      recordings, siteId, sites, isSuperadmin,
      reviewQueue,
      saved: req.query.saved === "1",
      error: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// ── Admin: metriche settimanali chiamate ─────────────────────────────────
// PRIMA di /:id (path fisso) — altrimenti "metrics" verrebbe catturato come :id.
router.get("/admin/call-recordings/metrics", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = req.moduleSiteId;
    const report = await weeklyCallMetrics(siteId, {});
    const history = await callMetricsWeeklyHistory(siteId, { weeks: 8 });
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    res.render("admin/call-recordings/metrics", {
      report, history, siteId, sites, isSuperadmin,
    });
  } catch (err) { next(err); }
});

// ── Admin: nuova registrazione (form) ───────────────────────────────────
router.get("/admin/call-recordings/new", requireAuth, authorize("forms", "create"), async (req, res, next) => {
  try {
    const opportunities = await loadOpportunities(req.moduleSiteId);
    res.render("admin/call-recordings/new", {
      opportunities, siteId: req.moduleSiteId, error: null,
    });
  } catch (err) { next(err); }
});

// ── Admin: upload audio + crea registrazione ────────────────────────────
router.post("/admin/call-recordings", requireAuth, authorize("forms", "create"), upload.single("audio"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).render("admin/call-recordings/new", {
        opportunities: await loadOpportunities(req.moduleSiteId),
        siteId: req.moduleSiteId, error: "Seleziona un file audio.",
      });
    }
    const audioPath = `calls/${req.file.filename}`; // path relativo dentro media-protected

    const opportunityId = req.body.opportunity_id ? parseInt(req.body.opportunity_id, 10) : null;
    let contactEmail = String(req.body.contact_email || "").trim().toLowerCase();
    let contactName = String(req.body.contact_name || "").trim();
    let pipelineId = null;
    let funnelContext = {};

    if (opportunityId) {
      const opp = (await query(
        "SELECT id, contact_email, pipeline_id, title FROM opportunities WHERE id = $1 AND site_id = $2",
        [opportunityId, req.moduleSiteId]
      )).rows[0];
      if (!opp) {
        fs.unlink(path.join(PROTECTED_ROOT, audioPath), () => {});
        return res.status(400).render("admin/call-recordings/new", {
          opportunities: await loadOpportunities(req.moduleSiteId),
          siteId: req.moduleSiteId, error: "Opportunità non valida.",
        });
      }
      pipelineId = opp.pipeline_id;
      if (!contactEmail) contactEmail = opp.contact_email || "";
    }

    // Contesto funnel per i prompt: nome pipeline + stadi.
    if (pipelineId) {
      const pipe = (await query(
        "SELECT name, stages FROM pipelines WHERE id = $1 AND site_id = $2",
        [pipelineId, req.moduleSiteId]
      )).rows[0];
      let stages = [];
      try { stages = Array.isArray(pipe?.stages) ? pipe.stages : JSON.parse(pipe?.stages || "[]"); } catch { stages = []; }
      funnelContext = { pipeline_name: pipe?.name || "", stages };
    }

    const rec = await createRecording(req.moduleSiteId, {
      opportunity_id: opportunityId,
      contact_email: contactEmail,
      contact_name: contactName,
      setter_name: String(req.body.setter_name || "").trim().slice(0, 255),
      pipeline_id: pipelineId,
      funnel_context: funnelContext,
      audio_path: audioPath,
    });

    logger.info(`[call-recordings] #${rec.id} caricata (site ${req.moduleSiteId})`);
    res.redirect(`/admin/call-recordings/${rec.id}?site_id=${req.moduleSiteId}`);
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    logger.error(`[call-recordings] upload errore: ${err.message}`);
    if (req.path.startsWith("/api")) {
      return res.status(500).json({ error: "Errore durante l'upload" });
    }
    next(err);
  }
});

// ── Admin: dettaglio + process ──────────────────────────────────────────
router.get("/admin/call-recordings/:id", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const rec = await getRecording(req.moduleSiteId, req.params.id);
    if (!rec) return res.status(404).render("error", { message: "Registrazione non trovata" });
    const opportunities = await loadOpportunities(req.moduleSiteId);
    res.render("admin/call-recordings/show", {
      rec, opportunities, siteId: req.moduleSiteId,
      error: req.query.error || null,
    });
  } catch (err) { next(err); }
});

// ── Admin: processa (trascrivi + diarizza + valuta) ─────────────────────
router.post("/admin/call-recordings/:id/process", requireAuth, authorize("forms", "update"), processLimiter, async (req, res, next) => {
  try {
    await processRecording(req.moduleSiteId, req.params.id, {});
    res.redirect(`/admin/call-recordings/${req.params.id}?site_id=${req.moduleSiteId}`);
  } catch (err) {
    logger.error(`[call-recordings] process #${req.params.id} errore: ${err.message}`);
    res.redirect(`/admin/call-recordings/${req.params.id}?site_id=${req.moduleSiteId}&error=${encodeURIComponent(err.message)}`);
  }
});

// ── Admin: revisione umana del verdetto ─────────────────────────────────
// Passa l'identità reale di chi rivisto (Bug 1 / M4): req.user.name o email.
router.post("/admin/call-recordings/:id/review", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const valida = ["si", "no", "dubbia"].includes(req.body.valida) ? req.body.valida : null;
    if (!valida) {
      return res.redirect(`/admin/call-recordings/${req.params.id}?site_id=${req.moduleSiteId}&error=${encodeURIComponent("Valore non valido")}`);
    }
    const authorName = req.user?.name || req.user?.email || "";
    await reviewVerdict(req.moduleSiteId, req.params.id, { valida, reviewStatus: req.body.review_status, authorName });
    const back = req.body.back === "queue" ? "/admin/call-recordings?site_id=" + req.moduleSiteId + "&review=1&saved=1" : `/admin/call-recordings/${req.params.id}?site_id=${req.moduleSiteId}&saved=1`;
    res.redirect(back);
  } catch (err) { next(err); }
});

// ── Admin: revisione di massa della coda "dubbia" (M1) ──────────────────
// Body: { ids: [..], action: 'si'|'no'|'riservi' } — conferma o scarta in
// blocco le chiamate in attesa. Rispetta lo scoping per sito.
router.post("/admin/call-recordings/bulk-review", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x, 10)).filter(Number.isInteger) : [];
    const action = ["si", "no"].includes(req.body.action) ? req.body.action : null;
    if (!action || ids.length === 0) {
      return res.redirect(`/admin/call-recordings?site_id=${req.moduleSiteId}&review=1&error=${encodeURIComponent("Seleziona almeno una chiamata e un'azione")}`);
    }
    const authorName = req.user?.name || req.user?.email || "";
    let done = 0;
    for (const id of ids) {
      const rec = await getRecording(req.moduleSiteId, id);
      if (rec && rec.review_status === "revisione") {
        await reviewVerdict(req.moduleSiteId, id, { valida: action, reviewStatus: "confermato", authorName });
        done++;
      }
    }
    logger.info(`[call-recordings] bulk-review site ${req.moduleSiteId}: ${done}/${ids.length} → ${action}`);
    res.redirect(`/admin/call-recordings?site_id=${req.moduleSiteId}&review=1&saved=1`);
  } catch (err) { next(err); }
});

// ── Admin: elimina registrazione (e file audio) ─────────────────────────
router.post("/admin/call-recordings/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const rec = await getRecording(req.moduleSiteId, req.params.id);
    if (rec) {
      if (rec.audio_path) fs.unlink(path.join(PROTECTED_ROOT, rec.audio_path), () => {});
      await query("DELETE FROM call_recordings WHERE id = $1 AND site_id = $2", [parseInt(req.params.id, 10), req.moduleSiteId]);
    }
    res.redirect(`/admin/call-recordings?site_id=${req.moduleSiteId}`);
  } catch (err) { next(err); }
});

export default router;
