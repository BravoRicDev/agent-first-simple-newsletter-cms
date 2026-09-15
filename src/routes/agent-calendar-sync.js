import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listConfigs, getConfig, createConfig, updateConfig, deleteConfig, syncNow, listLogs,
} from "../services/calendar-sync.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 37 — Sync calendario bidirezionale (chiamate ↔ Google Calendar).
// Config per sito + esecuzione manuale del sync + log delle esecuzioni.
// Stesso pattern di agent-callsummaries.js: ogni route verifica canAccessSite
// e passa gli errori a next(err). L'auth (requireAuth + requireAgent) è
// applicata dal router padre — qui NON ripetiamo router.use('/api/agent', ...).
// Un errore di validazione (statusCode 400) viene mappato su 400; gli errori
// "soft" di syncNow (es. OAuth non configurato) tornano nel body con 200.
// ─────────────────────────────────────────────────────────────────────────

function parseIntStrict(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerCalendarSyncRoutes(router) {
  // ── Elenco config di sync del sito ────────────────────────────────────

  router.get("/api/agent/sites/:siteId/calendar-sync-configs", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const configs = await listConfigs(siteId);
      res.json({ configs });
    } catch (err) { next(err); }
  });

  // ── Creazione config ──────────────────────────────────────────────────
  // body: { oauth_connection_id?, calendar_id?, direction? ('both'|'in'|'out'),
  //         mapping?, active? }

  router.post("/api/agent/sites/:siteId/calendar-sync-configs", requireAgent, async (req, res, next) => {
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

  router.put("/api/agent/sites/:siteId/calendar-sync-configs/:configId", requireAgent, async (req, res, next) => {
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

  router.delete("/api/agent/sites/:siteId/calendar-sync-configs/:configId", requireAgent, async (req, res, next) => {
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

  // ── Esecuzione manuale del sync ───────────────────────────────────────
  // body: { direction? } override opzionale ('both'|'in'|'out'); senza
  // connessione OAuth attiva ritorna { error: 'OAuth non configurato: ...' }
  // con 200 (fallimento pulito) e registra un log con status 'error'.

  router.post("/api/agent/sites/:siteId/calendar-sync-configs/:configId/sync", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const configId = parseIntStrict(req.params.configId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!configId) return res.status(404).json({ error: "Configurazione non trovata" });
      const result = await syncNow(siteId, configId, { direction: req.body?.direction });
      if (result.error === "Configurazione non trovata") {
        return res.status(404).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // ── Log delle esecuzioni ──────────────────────────────────────────────
  // query: limit (default 50, max 500)

  router.get("/api/agent/sites/:siteId/calendar-sync-configs/:configId/log", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const configId = parseIntStrict(req.params.configId);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!configId) return res.status(404).json({ error: "Configurazione non trovata" });
      const config = await getConfig(siteId, configId);
      if (!config) return res.status(404).json({ error: "Configurazione non trovata" });
      const logs = await listLogs(siteId, configId, { limit: req.query.limit });
      res.json({ logs });
    } catch (err) { next(err); }
  });
}
