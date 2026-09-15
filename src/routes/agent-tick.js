import { requireAgent, canAccessSite } from "./agent-helpers.js";
import { runTick } from "../services/tick.js";

// ─────────────────────────────────────────────────────────────────────────
// ONDA2 Phase 6 — tick "on demand": azioni differite dei workflow, decay
// scoring, refresh segmenti dinamici, in un'unica chiamata (per CLI/cron
// esterni, oltre allo scheduler interno già attivo in scheduler.js).
//
// Senza site_id processa TUTTI i siti: riservato a superadmin, altrimenti
// un agente di un singolo tenant potrebbe innescare processing su dati di
// altri tenant. Con site_id richiede accesso al sito (canAccessSite, stesso
// controllo usato da tutte le altre route /api/agent/sites/:siteId/*).
// ─────────────────────────────────────────────────────────────────────────

export function registerTickRoutes(router) {
  router.post("/api/agent/tick", requireAgent, async (req, res, next) => {
    try {
      const rawSiteId = req.body?.site_id ?? req.query?.site_id;
      let siteId = null;
      if (rawSiteId !== undefined && rawSiteId !== null && rawSiteId !== "") {
        siteId = parseInt(rawSiteId, 10);
        if (!Number.isInteger(siteId) || siteId < 1) {
          return res.status(400).json({ error: "site_id non valido" });
        }
        if (!await canAccessSite(req.user, siteId)) {
          return res.status(403).json({ error: "Accesso negato" });
        }
      } else if (req.user.role !== "superadmin") {
        return res.status(403).json({ error: "Tick globale riservato a superadmin: specifica site_id" });
      }

      const runDecay = req.body?.run_decay !== undefined ? !!req.body.run_decay : null;
      const runSegments = req.body?.run_segments !== undefined ? !!req.body.run_segments : null;

      const result = await runTick(siteId, { runDecay, runSegments });
      res.json({ tick: result });
    } catch (err) { next(err); }
  });
}
