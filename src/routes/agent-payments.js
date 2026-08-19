import { Router } from "express";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listPaymentLinks,
  getPaymentLink,
  createPaymentLink,
  updatePaymentLink,
  deletePaymentLink,
  markPaid,
} from "../services/payments.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 38 — Route agent per i link di pagamento Stripe (CRM).
//
// CRUD dei payment link + marcatura manuale "pagato" (es. pagamento
// ricevuto fuori da Stripe). NIENTE router.use qui: l'auth (requireAuth +
// requireAgent) è applicata dal mount point (stesso pattern di
// agent-kb.js), quindi ogni route richiede requireAgent e verifica
// canAccessSite. L'introspezione MCP (discoverTools) le vede
// automaticamente perché registrate sullo stesso router agent.
// ─────────────────────────────────────────────────────────────────────────

export function registerPaymentsRoutes(router) {
  // ── Elenco link (filtro status, paginazione limit/offset) ──────────────
  router.get("/api/agent/sites/:siteId/payment-links", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const payment_links = await listPaymentLinks(siteId, {
        status: req.query.status || null,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ payment_links });
    } catch (err) { next(err); }
  });

  // ── Dettaglio singolo link ─────────────────────────────────────────────
  router.get("/api/agent/sites/:siteId/payment-links/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const payment_link = await getPaymentLink(siteId, req.params.id);
      if (!payment_link) return res.status(404).json({ error: "Link di pagamento non trovato" });
      res.json({ payment_link });
    } catch (err) { next(err); }
  });

  // ── Creazione link ─────────────────────────────────────────────────────
  router.post("/api/agent/sites/:siteId/payment-links", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const payment_link = await createPaymentLink(siteId, req.body || {});
      if (!payment_link) return res.status(400).json({ error: "Titolo obbligatorio" });
      res.json({ payment_link });
    } catch (err) { next(err); }
  });

  // ── Aggiornamento link (title/description/amount/status) ───────────────
  router.put("/api/agent/sites/:siteId/payment-links/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const payment_link = await updatePaymentLink(siteId, req.params.id, req.body || {});
      if (!payment_link) return res.status(404).json({ error: "Link di pagamento non trovato" });
      res.json({ payment_link });
    } catch (err) { next(err); }
  });

  // ── Eliminazione link ──────────────────────────────────────────────────
  router.delete("/api/agent/sites/:siteId/payment-links/:id", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deletePaymentLink(siteId, req.params.id);
      if (!deleted) return res.status(404).json({ error: "Link di pagamento non trovato" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });

  // ── Marca come pagato (payment_link_id + opzionale by) ─────────────────
  router.post("/api/agent/sites/:siteId/payment-links/:id/mark-paid", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await markPaid(siteId, req.params.id, { by: req.body?.by || "" });
      if (!result) return res.status(404).json({ error: "Link di pagamento non trovato" });
      res.json(result);
    } catch (err) { next(err); }
  });
}

// Router autonomo esportato per i test (montato con requireAuth +
// requireAgent su un router locale, come prescrive la convenzione) e per
// chi preferisce app.use(...) diretto.
export const paymentsRouter = Router();
registerPaymentsRoutes(paymentsRouter);
