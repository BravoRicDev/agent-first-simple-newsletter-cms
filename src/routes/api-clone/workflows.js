import { Router } from "express";
import { query } from "../../db.js";
import { sendError, requireAnyId, getPaging, sendList } from "./_helpers.js";
import { recordComparison, isPassthroughActive, compareGhlSubset } from "../../services/ghl-parity.js";
import { logger } from "../../services/logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Round 16: Workflows sorgente — clone API in SOLA LETTURA.
//
// La tabella source_workflows è la copia dei payload REALI di sorgente (endpoint
// sorgente GET /workflows/, recuperato dal mapper source-sync
// "source-workflows"): ogni riga conserva il JSON integrale com'era nella
// risposta sorgente, nella colonna `payload`. Servire quel payload così com'è
// garantisce parità byte-per-byte con il sorgente (hot-swap n8n: stessa
// shape, stesso id reale).
//
// Nota id: source_workflows NON ha external_id/UUID proprio — l'unico
// identificatore è source_id (l'id reale di sorgente). Niente findByAnyId/publicId:
// lookup diretto su source_id, già site-scoped (UNIQUE(site_id, source_id),
// db/126). È il caso "rovesciato" rispetto alle altre risorse: qui l'id
// esposto è SEMPER quello reale, non serve preferirlo.
//
// POST/PUT/DELETE volutamente ASSENTI: questo CMS non può creare/executare
// workflow sorgente veri (l'engine nativo "Automazioni v2" di src/services/
// workflows.js è un sistema DISTINTO e non va confuso con questa tabella —
// stesso motivo per cui il mapper si chiama "source-workflows"). Un hot-swap
// n8n che prova a scrivere un workflow su di noi prenderebbe 404, esattamente
// come lo prenderebbe oggi da sorgente per tipi di workflow non supportati in API.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

const WORKFLOWS_PARITY_ENDPOINT = "GET /workflows";

// Shadow-verifica fire-and-forget (vedi services/ghl-parity.js): solo sulla
// pagina completa (nessun cursore), stesso motivo di tags.js.
function scheduleWorkflowsParityCheck(siteId, serializedWorkflows) {
  isPassthroughActive(siteId, WORKFLOWS_PARITY_ENDPOINT)
    .then((active) => {
      if (active) return;
      return recordComparison({
        siteId,
        endpoint: WORKFLOWS_PARITY_ENDPOINT,
        clonePayload: serializedWorkflows,
        isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.workflows || p || [] }),
        fetchReal: async () => {
          const { loadConfig, createSourceClient } = await import("../../services/source-sync/client.js");
          const cfg = await loadConfig(siteId);
          if (!cfg || !cfg.enabled) throw new Error("source-sync non configurato");
          const client = createSourceClient(cfg);
          return client.get("/workflows/", { locationId: cfg.location_id });
        },
      });
    })
    .catch((err) => logger.error(`scheduleWorkflowsParityCheck fallita (site ${siteId}): ${err.message}`));
}

// GET /workflows — lista workflow sincronizzati (payload sorgente integrali)
router.get("/workflows", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const siteId = req.tenant.siteId;

    let sql = "SELECT id, source_id, payload FROM source_workflows WHERE site_id = $1";
    const params = [siteId];

    if (startAfterId) {
      // Cursore = source_id reale (unico id esposto da questa risorsa)
      const after = (await query(
        "SELECT id FROM source_workflows WHERE site_id = $1 AND source_id = $2",
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
      "SELECT COUNT(*)::int AS cnt FROM source_workflows WHERE site_id = $1",
      [siteId]
    )).rows[0].cnt, 10);

    let nextStartAfterId = null;
    if (result.rows.length > limit && rows.length > 0) {
      nextStartAfterId = rows[rows.length - 1].source_id || null;
    }

    // I payload sono le risposte sorgente originali: nessuna trasformazione.
    const serialized = rows.map(r => r.payload);
    if (!startAfterId && !nextStartAfterId) {
      scheduleWorkflowsParityCheck(siteId, serialized);
    }
    sendList(res, "workflows", serialized, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:workflowId — singolo workflow per id reale sorgente
router.get("/workflows/:workflowId", async (req, res, next) => {
  try {
    const workflowId = requireAnyId(req.params.workflowId, res);
    if (!workflowId) return;

    const row = (await query(
      "SELECT payload FROM source_workflows WHERE site_id = $1 AND source_id = $2",
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
