import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  exportSiteData, exportCsv, importContacts, importCrmData,
  listImportJobs, getImportJob, isExportableTable,
} from "../services/export-import.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 39 — Export/import completo del CRM (JSON/CSV + log job).
// Registrate DIRETTAMENTE sul router agent dal padre (stesso pattern di
// registerCrmRoutes): qui NON si ripete router.use('/api/agent', ...).
// ─────────────────────────────────────────────────────────────────────────

export function registerExportRoutes(router) {
  // Export dati CRM: ?format=json (default) | csv, ?tables=contacts,tasks
  // (solo per JSON; il CSV è sempre sui contatti). Tabelle non supportate →
  // 400 con l'elenco, così un typo non produce un export vuoto silenzioso.
  router.get("/api/agent/sites/:siteId/data-export", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });

      const format = req.query.format === "csv" ? "csv" : "json";
      if (format === "csv") {
        const csv = await exportCsv(siteId);
        res.set({
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="contacts-${siteId}.csv"`,
        });
        return res.send(csv);
      }

      const tables = String(req.query.tables || "")
        .split(",").map(t => t.trim()).filter(Boolean);
      const invalid = tables.filter(t => !isExportableTable(t));
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Tabelle non supportate: ${invalid.join(", ")}` });
      }
      const data = await exportSiteData(siteId, { tables });
      res.json(data);
    } catch (err) { next(err); }
  });

  // Import dati CRM: body { kind:'contacts', rows:[...] } oppure
  // { kind:'crm', contacts:[], tasks:[] } (+ created_by opzionale).
  // Ogni import scrive una riga in import_jobs (status done + stats).
  router.post("/api/agent/sites/:siteId/data-import", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });

      const body = req.body || {};
      const kind = body.kind === "crm" ? "crm" : "contacts";
      const createdBy = String(body.created_by || req.user?.email || "").slice(0, 255);

      if (kind === "crm") {
        if (!Array.isArray(body.contacts) && !Array.isArray(body.tasks)) {
          return res.status(400).json({ error: "Body richiesto: { kind:'crm', contacts:[], tasks:[] }" });
        }
        const result = await importCrmData(siteId, {
          contacts: body.contacts || [],
          tasks: body.tasks || [],
          created_by: createdBy,
        });
        return res.json(result);
      }

      if (!Array.isArray(body.rows)) {
        return res.status(400).json({ error: "Body richiesto: { kind:'contacts', rows:[...] }" });
      }
      const result = await importContacts(siteId, { rows: body.rows, created_by: createdBy });
      res.json(result);
    } catch (err) { next(err); }
  });

  // Log degli import del sito (più recenti prima), ?limit=50 di default.
  router.get("/api/agent/sites/:siteId/import-jobs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const jobs = await listImportJobs(siteId, { limit: req.query.limit });
      res.json({ jobs });
    } catch (err) { next(err); }
  });

  // Dettaglio di un singolo job di import.
  router.get("/api/agent/sites/:siteId/import-jobs/:jobId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const job = await getImportJob(siteId, req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job di import non trovato" });
      res.json({ job });
    } catch (err) { next(err); }
  });
}
