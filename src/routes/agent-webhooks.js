import { query } from "../db.js";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listWebhooks, getWebhook, createWebhook, updateWebhook, deleteWebhook,
  deliverPending, sendWebhookPayload,
} from "../services/webhooks.js";
import { WEBHOOK_EVENTS, FILTERABLE_FIELDS } from "../constants/webhook-events.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 35 — Webhook IN/OUT (collegamento n8n). Route agent per gestire
// i webhook del sito e ispezionare/forzare le delivery OUT.
// Registrate DIRETTAMENTE sul router agent dal padre (stesso pattern di
// registerCrmRoutes): qui NON si ripete router.use('/api/agent', ...).
// ─────────────────────────────────────────────────────────────────────────

export function registerWebhooksRoutes(router) {
  // ── Delivery (statiche PRIMA di /webhooks/:webhookId? no: path diverso,
  //    ma l'ordine resta: run → list → CRUD per chiarezza) ───────────────

  // Catalogo eventi disponibili (source of truth per UI e agent).
  router.get("/api/agent/webhook-events", requireAgent, async (req, res) => {
    res.json({ events: WEBHOOK_EVENTS, filterable_fields: FILTERABLE_FIELDS });
  });

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

  router.post("/api/agent/sites/:siteId/webhooks/:webhookId/test", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const webhook = await getWebhook(siteId, webhookId);
      if (!webhook) return res.status(404).json({ error: "Webhook non trovato" });
      if (webhook.direction !== "out") return res.status(400).json({ error: "Il test è disponibile solo per webhook out" });

      const eventType = String(req.body?.event_type || webhook.events?.[0] || "test").slice(0, 100);
      const result = await sendWebhookPayload({
        url: webhook.url,
        secret: webhook.secret,
        eventType,
        payload: { test: true, at: new Date().toISOString(), ...(req.body?.payload || {}) },
      });
      res.json({ ok: result.ok, status: result.status, error: result.error || null });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/webhook-deliveries/:deliveryId/retry", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const deliveryId = parseInt(req.params.deliveryId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const updated = (await query(
        `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, last_error = '',
           next_attempt_at = NOW()
         WHERE id = $1 AND site_id = $2 RETURNING id, status`,
        [deliveryId, siteId]
      )).rows[0];
      if (!updated) return res.status(404).json({ error: "Delivery non trovata" });
      // Prova l'invio subito
      const result = await deliverPending(5, { siteId });
      res.json({ retried: deliveryId, deliver: result });
    } catch (err) { next(err); }
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
