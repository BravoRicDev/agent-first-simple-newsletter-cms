import { query } from "../db.js";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listWebhooks, getWebhook, createWebhook, updateWebhook, deleteWebhook,
  deliverPending,
} from "../services/webhooks.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 35 — Webhook IN/OUT (collegamento n8n). Route agent per gestire
// i webhook del sito e ispezionare/forzare le delivery OUT.
// Registrate DIRETTAMENTE sul router agent dal padre (stesso pattern di
// registerCrmRoutes): qui NON si ripete router.use('/api/agent', ...).
// ─────────────────────────────────────────────────────────────────────────

export function registerWebhooksRoutes(router) {
  // ── Delivery (statiche PRIMA di /webhooks/:webhookId? no: path diverso,
  //    ma l'ordine resta: run → list → CRUD per chiarezza) ───────────────

  // Esegue subito le delivery pending del sito (backoff/retry).
  router.post("/api/agent/sites/:siteId/webhook-deliveries/run", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await deliverPending(parseInt(req.body?.limit, 10) || 50, { siteId });
      res.json(result);
    } catch (err) { next(err); }
  });

  // Storico delivery con filtro opzionale per status.
  router.get("/api/agent/sites/:siteId/webhook-deliveries", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const params = [siteId];
      let where = "d.site_id = $1";
      if (["pending", "sent", "failed"].includes(req.query.status)) {
        params.push(req.query.status);
        where += ` AND d.status = $${params.length}`;
      }
      params.push(Math.min(parseInt(req.query.limit, 10) || 50, 200));
      const rows = (await query(
        `SELECT d.*, w.name AS webhook_name, w.url AS webhook_url
         FROM webhook_deliveries d
         LEFT JOIN webhooks w ON w.id = d.webhook_id
         WHERE ${where}
         ORDER BY d.created_at DESC
         LIMIT $${params.length}`,
        params
      )).rows;
      res.json({ deliveries: rows });
    } catch (err) { next(err); }
  });

  // ── CRUD webhooks ─────────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/webhooks", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const webhooks = await listWebhooks(siteId, { direction: req.query.direction || null });
      res.json({ webhooks });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/webhooks", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const webhook = await createWebhook(siteId, req.body || {});
      res.json({ webhook });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.put("/api/agent/sites/:siteId/webhooks/:webhookId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = await getWebhook(siteId, webhookId);
      if (!current) return res.status(404).json({ error: "Webhook non trovato" });
      const webhook = await updateWebhook(siteId, webhookId, req.body || {});
      res.json({ webhook });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.delete("/api/agent/sites/:siteId/webhooks/:webhookId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteWebhook(siteId, webhookId);
      if (!deleted) return res.status(404).json({ error: "Webhook non trovato" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });
}
