import { Router } from "express";
import { query } from "../../db.js";
import { sendError, requireAnyId, getPaging, sendList } from "./_helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// Round 17: Funnels GHL — clone API in SOLA LETTURA.
//
// ghl_funnels è la copia del sorgente (mapper source-sync "funnels", che
// legge GET /funnels/funnel/list): ogni riga conserva name + steps (array
// JSONB dei passi del funnel). Verificato sullo schema reale: la tabella
// NON ha external_id proprio → l'unico id pubblico è ghl_id (20 char
// alfanumerici reali di GHL, es. "1g9OWTij9iU9yzKXOyWb"): niente
// findByAnyId/publicId, lookup diretto site-scoped (UNIQUE(site_id, ghl_id),
// db/126). Stesso pattern di ghl_workflows (round 16), non quello "doppio
// id" delle risorse CRUD locali.
//
// POST/PUT/DELETE volutamente assenti: un funnel è una pubblicazione
// (pagina/step) che vive nell'editor GHL e richiede servizi esterni
// (hosting pagine, domini) — replicarne la scrittura qui senza un vero
// motore di rendering sarebbe una parità ingannevole (l'oggetto creato non
// funzionerebbe come su GHL). Il CMS non ha un engine funnel proprio.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

function serializeFunnel(row) {
  return {
    id: row.ghl_id,
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

    let sql = "SELECT id, ghl_id, name, steps, created_at, updated_at FROM ghl_funnels WHERE site_id = $1";
    const params = [siteId];

    if (startAfterId) {
      // Cursore = ghl_id reale (unico id esposto da questa risorsa)
      const after = (await query(
        "SELECT id FROM ghl_funnels WHERE site_id = $1 AND ghl_id = $2",
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
      "SELECT COUNT(*)::int AS cnt FROM ghl_funnels WHERE site_id = $1",
      [siteId]
    )).rows[0].cnt, 10);

    let nextStartAfterId = null;
    if (result.rows.length > limit && rows.length > 0) {
      nextStartAfterId = rows[rows.length - 1].ghl_id || null;
    }

    sendList(res, "funnels", rows.map(serializeFunnel), total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// GET /funnels/:funnelId — singolo funnel per id reale GHL
router.get("/funnels/:funnelId", async (req, res, next) => {
  try {
    const funnelId = requireAnyId(req.params.funnelId, res);
    if (!funnelId) return;

    const row = (await query(
      `SELECT id, ghl_id, name, steps, created_at, updated_at
       FROM ghl_funnels WHERE site_id = $1 AND ghl_id = $2`,
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
