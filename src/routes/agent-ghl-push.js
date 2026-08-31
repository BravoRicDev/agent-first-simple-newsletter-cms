import { query } from "../db.js";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import { processPushQueue } from "../services/source-sync/push.js";

// ─────────────────────────────────────────────────────────────────────────
// API agent — Push bidirezionale verso il CRM sorgente (GoHighLevel).
//
// La configurazione abitativa (push_enabled/push_direction/push_events) vive
// in source_sync_config e si gestisce con gli endpoint source-sync esistenti
// (GET/PUT /api/agent/sites/:siteId/source-sync/config). Qui ci sono solo:
//   - run manuale del push (stessa garanzia single-fire dell'esecuzione dallo
//     scheduler: advisory lock per-sito + anti-echo + no-import + replica)
//   - stato/contatori della coda outbox
// ─────────────────────────────────────────────────────────────────────────

export function registerGhlPushRoutes(router) {
  // Esegue subito il drain della coda push del sito (fire-and-forget).
  router.post("/api/agent/sites/:siteId/ghl-push/run", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      const limit = Math.min(100, parseInt(req.body?.limit, 10) || 20);
      processPushQueue({ siteId, limit }).catch(() => {});
      res.json({ started: true });
    } catch (err) { next(err); }
  });

  // Stato della coda outbox del sito.
  router.get("/api/agent/sites/:siteId/ghl-push", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!(await canAccessSite(req.user, siteId))) {
        return res.status(403).json({ error: "Accesso negato" });
      }
      const counts = (await query(
        `SELECT status, COUNT(*)::int AS n
         FROM source_push_queue WHERE site_id = $1
         GROUP BY status ORDER BY status`,
        [siteId]
      )).rows;
      const recent = (
        await query(
          `SELECT id, entity_type, entity_id, external_id, operation, origin, status,
                  attempts, last_error, next_attempt_at, created_at
           FROM source_push_queue WHERE site_id = $1
           ORDER BY id DESC LIMIT 25`,
          [siteId]
        )
      ).rows;
      res.json({ counts, recent });
    } catch (err) { next(err); }
  });
}