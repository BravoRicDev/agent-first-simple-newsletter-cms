import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listConfigs, getConfig, createConfig, updateConfig, deleteConfig,
  generateReport, sendReport, listRuns,
} from "../services/reports.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 41 — Report periodici ai clienti.
// Config weekly/monthly con sezioni, generazione HTML/JSON (dry-run) e
// invio email con log in report_runs. Stesso pattern di
// agent-calendar-sync.js: ogni route verifica canAccessSite e passa gli
// errori a next(err). L'auth (requireAuth + requireAgent) è applicata dal
// router padre — qui NON ripetiamo router.use('/api/agent', ...).
// Un errore di validazione (statusCode 400) viene mappato su 400; gli
// errori "soft" (config inesistente → 404; nessun destinatario o invii
// falliti → body con 200) NON crashano mai.
// ─────────────────────────────────────────────────────────────────────────

function parseIntStrict(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerReportsRoutes(router) {
  // ── Elenco config report del sito ─────────────────────────────────────

  router.get("/api/agent/sites/:siteId/report-configs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const configs = await listConfigs(siteId);
      res.json({ configs });
    } catch (err) { next(err); }
  });

  // ── Creazione config ──────────────────────────────────────────────────
  // body: { name, kind? ('weekly'|'monthly'), sections?, recipients?, active? }
  // kind/sections/recipients vengono sanitizzati (whitelist, dedup, max 20).

  router.post("/api/agent/sites/:siteId/report-configs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const config = await createConfig(siteId, req.body || {});
      res.json({ config });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // ── Aggiornamento config ──────────────────────────────────────────────

  router.put("/api/agent/sites/:siteId/report-configs/:configId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const configId = parseIntStrict(req.params.configId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!configId) return res.status(404).json({ error: "Configurazione non trovata" });
      const config = await updateConfig(siteId, configId, req.body || {});
      if (!config) return res.status(404).json({ error: "Configurazione non trovata" });
      res.json({ config });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // ── Eliminazione config ───────────────────────────────────────────────

  router.delete("/api/agent/sites/:siteId/report-configs/:configId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const configId = parseIntStrict(req.params.configId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!configId) return res.status(404).json({ error: "Configurazione non trovata" });
      const deleted = await deleteConfig(siteId, configId);
      if (!deleted) return res.status(404).json({ error: "Configurazione non trovata" });
      res.json({ deleted: configId });
    } catch (err) { next(err); }
  });

  // ── Generazione dry-run ───────────────────────────────────────────────
  // Ritorna { config_id, generated_at, json, html } SENZA inviare email.

  router.post("/api/agent/sites/:siteId/report-configs/:configId/generate", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const configId = parseIntStrict(req.params.configId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!configId) return res.status(404).json({ error: "Configurazione non trovata" });
      const report = await generateReport(siteId, configId);
      if (!report) return res.status(404).json({ error: "Configurazione non trovata" });
      res.json(report);
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // ── Invio email ───────────────────────────────────────────────────────
  // Genera e invia ai destinatari; registra il run. Senza destinatari
  // ritorna { error: 'Nessun destinatario' } (200, nessun run); con invii
  // falliti ritorna { sent, errors } (200) e il run ha status 'error'.

  router.post("/api/agent/sites/:siteId/report-configs/:configId/send", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const configId = parseIntStrict(req.params.configId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!configId) return res.status(404).json({ error: "Configurazione non trovata" });
      const result = await sendReport(siteId, configId);
      if (result.error === "Configurazione non trovata") {
        return res.status(404).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // ── Storico run ───────────────────────────────────────────────────────
  // query: limit (default 50, max 500)

  router.get("/api/agent/sites/:siteId/report-configs/:configId/runs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const configId = parseIntStrict(req.params.configId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!configId) return res.status(404).json({ error: "Configurazione non trovata" });
      const config = await getConfig(siteId, configId);
      if (!config) return res.status(404).json({ error: "Configurazione non trovata" });
      const runs = await listRuns(siteId, configId, { limit: req.query.limit });
      res.json({ runs });
    } catch (err) { next(err); }
  });
}
