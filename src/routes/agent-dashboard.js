import { canAccessSite, requireAgent } from "./agent-helpers.js";
import { getKpis, listViews, createView, updateView, deleteView } from "../services/dashboard.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 40 — Dashboard realtime CRM: KPI live (lead per canale, SLA task,
// valore pipeline, conversazioni) + viste salvabili (layout widget).
// Registrate DIRETTAMENTE sul router agent dal padre (stesso pattern di
// registerCrmRoutes): qui NON si ripete router.use('/api/agent', ...).
// ─────────────────────────────────────────────────────────────────────────

export function registerDashboardRoutes(router) {
  // ── KPI live ──────────────────────────────────────────────────────────
  // range: 7d | 30d | 90d (default 30d); ogni dato è una query live.
  router.get("/api/agent/sites/:siteId/dashboard/kpis", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const kpis = await getKpis(siteId, { range: req.query.range });
      res.json(kpis);
    } catch (err) { next(err); }
  });

  // ── Viste salvabili (CRUD) ────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/dashboard/views", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      res.json({ views: await listViews(siteId) });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/dashboard/views", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const view = await createView(siteId, {
        name: req.body?.name,
        config: req.body?.config,
        createdBy: req.user?.sub ?? req.user?.id ?? null,
      });
      res.json({ view });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.put("/api/agent/sites/:siteId/dashboard/views/:viewId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const viewId = parseInt(req.params.viewId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const view = await updateView(siteId, viewId, req.body || {});
      if (!view) return res.status(404).json({ error: "Vista non trovata" });
      res.json({ view });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.delete("/api/agent/sites/:siteId/dashboard/views/:viewId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const viewId = parseInt(req.params.viewId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteView(siteId, viewId);
      if (!deleted) return res.status(404).json({ error: "Vista non trovata" });
      res.json({ deleted: viewId });
    } catch (err) { next(err); }
  });
}
