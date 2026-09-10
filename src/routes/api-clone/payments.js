import { Router } from "express";
import { query } from "../../db.js";
import { sendError, sendList, requireAnyId, getPaging, getLocationId } from "./_helpers.js";
import { findByAnyId, publicId } from "../../services/external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Round 20: Payment links — clone API in SOLA LETTURA.
//
// Verificato su schema reale (information_schema): payment_links ha SIA
// external_id (uuid, DEFAULT gen_random_uuid()) SIA ghl_id proprio, oltre a
// site_id → pattern "doppio id" classico (findByAnyId/publicId), NON il
// pattern mirror di ghl_workflows/funnels/custom_values.
//
// I dati arrivano dal mapper source-sync "commerce" (sezione GET /payments/
// del sorgente). ATTENZIONE nota reale: su QUESTO account GHL l'endpoint
// sorgente è bloccato da IAM (401 "IAM Service", documentato nei bug report
// 2026-09-08) → 0 righe in produzione finché non si risolve lato CRM. La
// route è comunque necessaria per la parità di superficie: appena il
// permesso viene concesso (o su un account diverso) i dati fluiscono senza
// ulteriori modifiche al clone.
//
// POST/PUT/DELETE volutamente assenti: un payment link reale esiste solo se
// emesso dal processor di pagamento di GHL (stripe_url/token generati
// lato sorgente) — crearne uno qui produrrebbe un oggetto senza URL pagabile
// funzionante: parità ingannevole. Il campo interno `token` (pagine /pay/
// del CMS) non viene esposto: non è un campo della risposta sorgente.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

function serializePayment(row, locationId) {
  return {
    id: publicId(row),
    locationId,
    title: row.title || "",
    amount: Number(row.amount) || 0,
    currency: row.currency || "EUR",
    contactEmail: row.contact_email || "",
    status: row.status || "draft",
    url: row.stripe_url || "",
    description: row.description || "",
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    dateAdded: row.created_at ? new Date(row.created_at).toISOString() : null,
    dateUpdated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

// GET /payments — lista payment link sincronizzati
router.get("/payments", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const siteId = req.tenant.siteId;
    const locationId = await getLocationId(req.tenant);

    let sql = `SELECT id, external_id, ghl_id, title, amount, currency, contact_email,
                      status, stripe_url, description, paid_at, created_at, updated_at
               FROM payment_links WHERE site_id = $1`;
    const params = [siteId];

    if (startAfterId) {
      // Cursore doppio-id: accetta UUID interno O ghl_id reale, site-scoped
      const after = await findByAnyId("payment_links", siteId, startAfterId);
      if (after) {
        params.push(after.id);
        sql += ` AND id > $${params.length}`;
      }
    }

    params.push(limit + 1);
    sql += ` ORDER BY id ASC LIMIT $${params.length}`;

    const result = await query(sql, params);
    const rows = result.rows.slice(0, limit);

    const total = parseInt((await query(
      "SELECT COUNT(*)::int AS cnt FROM payment_links WHERE site_id = $1",
      [siteId]
    )).rows[0].cnt, 10);

    let nextStartAfterId = null;
    if (result.rows.length > limit && rows.length > 0) {
      nextStartAfterId = publicId(rows[rows.length - 1]);
    }

    sendList(res, "payments", rows.map(r => serializePayment(r, locationId)), total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// GET /payments/:paymentId — singolo payment link (UUID interno o ghl_id)
router.get("/payments/:paymentId", async (req, res, next) => {
  try {
    const paymentId = requireAnyId(req.params.paymentId, res);
    if (!paymentId) return;

    const row = await findByAnyId("payment_links", req.tenant.siteId, paymentId);
    if (!row) {
      return sendError(res, 404, "Payment link non trovato");
    }

    const locationId = await getLocationId(req.tenant);
    res.json({ payment: serializePayment(row, locationId) });
  } catch (err) {
    next(err);
  }
});

export default router;
