import { Router } from "express";
import { query } from "../../db.js";
import { sendError, requireAnyId, getPaging, sendList } from "./_helpers.js";
import { recordComparison, isPassthroughActive, compareGhlSubset } from "../../services/ghl-parity.js";
import { logger } from "../../services/logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Round 17: Funnels sorgente — clone API in SOLA LETTURA.
//
// source_funnels è la copia del sorgente (mapper source-sync "funnels", che
// legge GET /funnels/funnel/list): ogni riga conserva name + steps (array
// JSONB dei passi del funnel). Verificato sullo schema reale: la tabella
// NON ha external_id proprio → l'unico id pubblico è source_id (20 char
// alfanumerici reali di sorgente, es. "1g9OWTij9iU9yzKXOyWb"): niente
// findByAnyId/publicId, lookup diretto site-scoped (UNIQUE(site_id, source_id),
// db/126). Stesso pattern di source_workflows (round 16), non quello "doppio
// id" delle risorse CRUD locali.
//
// POST/PUT/DELETE volutamente assenti: un funnel è una pubblicazione
// (pagina/step) che vive nell'editor sorgente e richiede servizi esterni
// (hosting pagine, domini) — replicarne la scrittura qui senza un vero
// motore di rendering sarebbe una parità ingannevole (l'oggetto creato non
// funzionerebbe come su sorgente). Il CMS non ha un engine funnel proprio.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

const FUNNELS_PARITY_ENDPOINT = "GET /funnels";

// Shadow-verifica fire-and-forget (vedi services/ghl-parity.js). Attenzione:
// GHL espone l'id dei funnel come `_id`, non `id` (vedi mappers/funnels.js) —
// compareGhlSubset lo gestisce già col fallback su ghlIdField.
function scheduleFunnelsParityCheck(siteId, serializedFunnels) {
  isPassthroughActive(siteId, FUNNELS_PARITY_ENDPOINT)
    .then((active) => {
      if (active) return;
      return recordComparison({
        siteId,
        endpoint: FUNNELS_PARITY_ENDPOINT,
        clonePayload: serializedFunnels,
        isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.funnels || p || [] }),
        fetchReal: async () => {
          const { loadConfig, createSourceClient } = await import("../../services/source-sync/client.js");
          const cfg = await loadConfig(siteId);
          if (!cfg || !cfg.enabled) throw new Error("source-sync non configurato");
          const client = createSourceClient(cfg);
          return client.get("/funnels/funnel/list", { locationId: cfg.location_id });
        },
      });
    })
    .catch((err) => logger.error(`scheduleFunnelsParityCheck fallita (site ${siteId}): ${err.message}`));
}

function serializeFunnel(row) {
  return {
    id: row.source_id,
    name: row.name || "",
    // steps è l'array JSONB dei passi già nel formato del sorgente
    // (il mapper salva f.steps quando presente). Se a suo tempo è
    // finito lì l'oggetto intero (fallback f.steps || f), viene
    // comunque servito com'è, senza trasformazioni inventate.
    steps: row.steps ?? [],
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

// GET /funnels — lista funnel sincronizzati
router.get("/funnels", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const siteId = req.tenant.siteId;

    let sql = "SELECT id, source_id, name, steps, created_at, updated_at FROM source_funnels WHERE site_id = $1";
    const params = [siteId];

    if (startAfterId) {
      // Cursore = source_id reale (unico id esposto da questa risorsa)
      const after = (await query(
        "SELECT id FROM source_funnels WHERE site_id = $1 AND source_id = $2",
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
      "SELECT COUNT(*)::int AS cnt FROM source_funnels WHERE site_id = $1",
      [siteId]
    )).rows[0].cnt, 10);

    let nextStartAfterId = null;
    if (result.rows.length > limit && rows.length > 0) {
      nextStartAfterId = rows[rows.length - 1].source_id || null;
    }

    const serialized = rows.map(serializeFunnel);
    if (!startAfterId && !nextStartAfterId) {
      scheduleFunnelsParityCheck(siteId, serialized);
    }
    sendList(res, "funnels", serialized, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// GET /funnels/:funnelId — singolo funnel per id reale sorgente
router.get("/funnels/:funnelId", async (req, res, next) => {
  try {
    const funnelId = requireAnyId(req.params.funnelId, res);
    if (!funnelId) return;

    const row = (await query(
      `SELECT id, source_id, name, steps, created_at, updated_at
       FROM source_funnels WHERE site_id = $1 AND source_id = $2`,
      [req.tenant.siteId, funnelId]
    )).rows[0];

    if (!row) {
      return sendError(res, 404, "Funnel non trovato");
    }

    res.json({ funnel: serializeFunnel(row) });
  } catch (err) {
    next(err);
  }
});

export default router;
