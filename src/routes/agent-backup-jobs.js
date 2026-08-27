import { canAccessSite, requireAgent } from "./agent-helpers.js";
import { runBackup, listJobs, getJob, deleteJob, BACKUP_KINDS } from "../services/backup-jobs.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 43 — Backup automatici con storico.
// L'agente può lanciare un backup manuale (POST), elencare lo storico dei
// job (GET), vederne il dettaglio (GET :jobId) ed eliminarlo (DELETE), il
// tutto per sito. Ogni tentativo resta registrato in backup_jobs anche se
// fallisce (es. pg_dump assente). Stesso pattern di agent-callsummaries.js:
// canAccessSite per ogni route, errori a next(err). L'auth (requireAuth +
// requireAgent) è applicata dal router padre — qui NON ripetiamo
// router.use('/api/agent', ...).
// ─────────────────────────────────────────────────────────────────────────

export function registerBackupJobsRoutes(router) {
  // ── Storico dei job di backup del sito ─────────────────────────────────

  router.get("/api/agent/sites/:siteId/backup-jobs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const jobs = await listJobs(siteId, { limit: req.query.limit });
      res.json({ jobs });
    } catch (err) { next(err); }
  });

  // ── Esecuzione manuale di un backup ───────────────────────────────────
  // body: { kind?: 'full'|'db'|'media' (default 'full'), site_id?: number }
  // (site_id esplicito = backup per un altro sito accessibile; null =
  // backup globale, solo superadmin — altrimenti vale il :siteId del path).

  router.post("/api/agent/sites/:siteId/backup-jobs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const body = req.body || {};
      const kind = BACKUP_KINDS.includes(body.kind) ? body.kind : "full";

      let targetSiteId = siteId;
      if (body.site_id === null && req.user.role === "superadmin") {
        targetSiteId = null; // backup globale
      } else if (body.site_id !== undefined && body.site_id !== null && body.site_id !== "") {
        const n = parseInt(body.site_id, 10);
        if (Number.isInteger(n) && n >= 1) {
          if (!await canAccessSite(req.user, n)) return res.status(403).json({ error: "Accesso negato" });
          targetSiteId = n;
        }
      }

      const result = await runBackup({ siteId: targetSiteId, kind, created_by: "manual" });
      res.json(result);
    } catch (err) { next(err); }
  });

  // ── Dettaglio di un job ────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/backup-jobs/:jobId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const job = await getJob(siteId, req.params.jobId);
      if (!job) return res.status(404).json({ error: "Backup non trovato" });
      res.json({ job });
    } catch (err) { next(err); }
  });

  // ── Eliminazione di un job (e del file fisico, solo se in backups/) ───

  router.delete("/api/agent/sites/:siteId/backup-jobs/:jobId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const jobId = parseInt(req.params.jobId, 10);
      const deleted = await deleteJob(siteId, jobId);
      if (!deleted) return res.status(404).json({ error: "Backup non trovato" });
      res.json({ deleted: jobId });
    } catch (err) { next(err); }
  });
}
