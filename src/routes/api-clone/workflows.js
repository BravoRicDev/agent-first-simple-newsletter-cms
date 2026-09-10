import { Router } from "express";
import { query } from "../../db.js";
import { sendError, requireAnyId, getPaging, sendList } from "./_helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// Round 16: Workflows GHL — clone API in SOLA LETTURA.
//
// La tabella ghl_workflows è la copia dei payload REALI di GHL (endpoint
// sorgente GET /workflows/, recuperato dal mapper source-sync
// "ghl-workflows"): ogni riga conserva il JSON integrale com'era nella
// risposta GHL, nella colonna `payload`. Servire quel payload così com'è
// garantisce parità byte-per-byte con il sorgente (hot-swap n8n: stessa
// shape, stesso id reale).
//
// Nota id: ghl_workflows NON ha external_id/UUID proprio — l'unico
// identificatore è ghl_id (l'id reale di GHL). Niente findByAnyId/publicId:
// lookup diretto su ghl_id, già site-scoped (UNIQUE(site_id, ghl_id),
// db/126). È il caso "rovesciato" rispetto alle altre risorse: qui l'id
// esposto è SEMPER quello reale, non serve preferirlo.
//
// POST/PUT/DELETE volutamente ASSENTI: questo CMS non può creare/executare
// workflow GHL veri (l'engine nativo "Automazioni v2" di src/services/
// workflows.js è un sistema DISTINTO e non va confuso con questa tabella —
// stesso motivo per cui il mapper si chiama "ghl-workflows"). Un hot-swap
// n8n che prova a scrivere un workflow su di noi prenderebbe 404, esattamente
// come lo prenderebbe oggi da GHL per tipi di workflow non supportati in API.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// GET /workflows — lista workflow sincronizzati (payload GHL integrali)
router.get("/workflows", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const siteId = req.tenant.siteId;

    let sql = "SELECT id, ghl_id, payload FROM ghl_workflows WHERE site_id = $1";
    const params = [siteId];

    if (startAfterId) {
      // Cursore = ghl_id reale (unico id esposto da questa risorsa)
      const after = (await query(
        "SELECT id FROM ghl_workflows WHERE site_id = $1 AND ghl_id = $2",
        [siteId, startAfterId]
      )).rows[0];
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
      "SELECT COUNT(*)::int AS cnt FROM ghl_workflows WHERE site_id = $1",
      [siteId]
    )).rows[0].cnt, 10);

    let nextStartAfterId = null;
    if (result.rows.length > limit && rows.length > 0) {
      nextStartAfterId = rows[rows.length - 1].ghl_id || null;
    }

    // I payload sono le risposte GHL originali: nessuna trasformazione.
    sendList(res, "workflows", rows.map(r => r.payload), total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:workflowId — singolo workflow per id reale GHL
router.get("/workflows/:workflowId", async (req, res, next) => {
  try {
    const workflowId = requireAnyId(req.params.workflowId, res);
    if (!workflowId) return;

    const row = (await query(
      "SELECT payload FROM ghl_workflows WHERE site_id = $1 AND ghl_id = $2",
      [req.tenant.siteId, workflowId]
    )).rows[0];

    if (!row) {
      return sendError(res, 404, "Workflow non trovato");
    }

    res.json({ workflow: row.payload });
  } catch (err) {
    next(err);
  }
});

export default router;
