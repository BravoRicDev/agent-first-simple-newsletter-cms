import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listApps, createApp, updateApp, deleteApp,
  getAuthUrl, exchangeCode, refreshToken,
  listConnections, disconnect,
} from "../services/oauth.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 36 — OAuth Google: route agent per gestire app OAuth e
// connessioni Gmail/Calendar/Drive del sito.
// Registrate DIRETTAMENTE sul router agent dal padre (stesso pattern di
// registerWebhooksRoutes/registerCrmRoutes): qui NON si ripete
// router.use('/api/agent', ...). Guard canAccessSite su ogni route
// (403 'Accesso negato'), try/catch con next(err).
// ─────────────────────────────────────────────────────────────────────────

export function registerOauthRoutes(router) {
  // ── CRUD app OAuth ────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/oauth-apps", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const apps = await listApps(siteId);
      res.json({ apps });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/oauth-apps", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const app = await createApp(siteId, req.body || {});
      res.json({ app });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.put("/api/agent/sites/:siteId/oauth-apps/:appId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const appId = parseInt(req.params.appId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const app = await updateApp(siteId, appId, req.body || {});
      res.json({ app });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.delete("/api/agent/sites/:siteId/oauth-apps/:appId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const appId = parseInt(req.params.appId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await deleteApp(siteId, appId);
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // ── Flusso OAuth ──────────────────────────────────────────────────────

  // URL di autorizzazione Google (avvia il consenso dell'utente).
  router.post("/api/agent/sites/:siteId/oauth/auth-url", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await getAuthUrl(siteId, req.body || {});
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (err) { next(err); }
  });

  // Scambio del codice di autorizzazione con i token (chiamato anche dal
  // callback pubblico). Ritorna SEMPRE 200: {error} in caso di fallimento
  // pulito (mai 500).
  router.post("/api/agent/sites/:siteId/oauth/exchange", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await exchangeCode(siteId, req.body || {});
      res.json(result);
    } catch (err) { next(err); }
  });

  // Connessioni salvate per il sito.
  router.get("/api/agent/sites/:siteId/oauth/connections", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const connections = await listConnections(siteId);
      res.json({ connections });
    } catch (err) { next(err); }
  });

  // Disconnette l'app (active=false, token conservati per un ri-collegamento).
  router.post("/api/agent/sites/:siteId/oauth/disconnect", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await disconnect(siteId, req.body?.app_id);
      res.json(result);
    } catch (err) { next(err); }
  });

  // Rinnova l'access_token della connessione via refresh_token.
  router.post("/api/agent/sites/:siteId/oauth/refresh", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await refreshToken(siteId, req.body?.connection_id);
      res.json(result);
    } catch (err) { next(err); }
  });
}
