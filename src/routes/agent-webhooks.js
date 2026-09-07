import { query } from "../db.js";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listWebhooks, getWebhook, createWebhook, updateWebhook, deleteWebhook,
  deliverPending, sendWebhookPayload,
  ipInAllowedList, verifyHmacSignature, matchesFilter,
} from "../services/webhooks.js";
import { WEBHOOK_EVENTS, FILTERABLE_FIELDS } from "../constants/webhook-events.js";
import crypto from "crypto";

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

  // ── Sicurezza inbound: log, rotate token, rotate verify_secret, dry-run ──

  // Storico tentativi INBOUND (accepted/filtered/ip_blocked/signature_fail/invalid_token).
  router.get("/api/agent/sites/:siteId/webhooks/inbound-log", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const params = [siteId];
      let where = "l.site_id = $1";
      const status = String(req.query.status || "");
      if (["accepted", "filtered", "ip_blocked", "signature_fail", "invalid_token", "error"].includes(status)) {
        params.push(status);
        where += ` AND l.status = $${params.length}`;
      }
      if (req.query.webhook_id) {
        params.push(parseInt(req.query.webhook_id, 10));
        where += ` AND l.webhook_id = $${params.length}`;
      }
      params.push(Math.min(parseInt(req.query.limit, 10) || 50, 200));
      const rows = (await query(
        `SELECT l.id, l.webhook_id, l.event_type, l.ip::text AS ip, l.status, l.reason,
                l.created_at, w.name AS webhook_name
         FROM webhook_inbound_log l
         LEFT JOIN webhooks w ON w.id = l.webhook_id
         WHERE ${where}
         ORDER BY l.created_at DESC
         LIMIT $${params.length}`,
        params
      )).rows;
      res.json({ log: rows });
    } catch (err) { next(err); }
  });

  // Rigenera il token (secret) del webhook IN: il vecchio token smette di funzionare.
  router.post("/api/agent/sites/:siteId/webhooks/:webhookId/rotate-token", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = await getWebhook(siteId, webhookId);
      if (!current) return res.status(404).json({ error: "Webhook non trovato" });
      const { randomBytes } = await import("crypto");
      const newSecret = randomBytes(16).toString("hex"); // 32 char
      const updated = await query(
        `UPDATE webhooks SET secret = $1, updated_at = NOW() WHERE id = $2 AND site_id = $3 RETURNING *`,
        [newSecret, webhookId, siteId]
      );
      res.json({ webhook: updated.rows[0] });
    } catch (err) { next(err); }
  });

  // Rigenera la verify_secret (chiave HMAC) per la verifica firma inbound.
  router.post("/api/agent/sites/:siteId/webhooks/:webhookId/rotate-verify-secret", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const current = await getWebhook(siteId, webhookId);
      if (!current) return res.status(404).json({ error: "Webhook non trovato" });
      const { randomBytes } = await import("crypto");
      const newSecret = randomBytes(32).toString("hex"); // 64 char
      const updated = await query(
        `UPDATE webhooks SET verify_secret = $1, updated_at = NOW() WHERE id = $2 AND site_id = $3 RETURNING *`,
        [newSecret, webhookId, siteId]
      );
      res.json({ webhook: updated.rows[0] });
    } catch (err) { next(err); }
  });

  // Dry-run inbound: simula una chiamata al webhook IN (filtri/allowlist/HMAC)
  // SENZA eseguire azioni. Utile per testare il mapping e i filtri di sicurezza.
  router.post("/api/agent/sites/:siteId/webhooks/:webhookId/dry-run", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      const webhookId = parseInt(req.params.webhookId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const webhook = await getWebhook(siteId, webhookId);
      if (!webhook) return res.status(404).json({ error: "Webhook non trovato" });
      if (webhook.direction !== "in") return res.status(400).json({ error: "Dry-run disponibile solo per webhook in" });

      const body = req.body?.payload || {};
      const bodyStr = typeof req.body?.payload_raw === "string" ? req.body.payload_raw : JSON.stringify(body);
      const signature = String(req.body?.signature || "");
      const ip = String(req.body?.ip || "127.0.0.1");

      const checks = {};
      // Allowlist IP
      if (webhook.allowed_ips && webhook.allowed_ips.length > 0) {
        checks.ip_allowed = ipInAllowedList(ip, webhook.allowed_ips);
      } else {
        checks.ip_allowed = true;
      }
      // HMAC
      if (webhook.verify_secret) {
        checks.signature_valid = signature
          ? verifyHmacSignature(webhook.verify_secret, bodyStr, signature)
          : false;
      } else {
        checks.signature_valid = null; // non richiesta
      }
      // Filtro payload
      if (webhook.filter && Object.keys(webhook.filter).length > 0) {
        checks.filter_match = matchesFilter(webhook.filter, body.payload || body);
      } else {
        checks.filter_match = true;
      }
      // Mapping
      const mapping = webhook.events && typeof webhook.events === "object" && !Array.isArray(webhook.events) ? webhook.events : {};
      const eventType = String(body.event_type || body.type || "").trim();
      checks.would_execute = (eventType && mapping[eventType]) ? mapping[eventType] : (Object.keys(mapping)[0] || null);

      res.json({ webhook_id: webhookId, checks, would_execute: checks.would_execute });
    } catch (err) { next(err); }
  });
}
