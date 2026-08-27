import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { PIPELINE_STAGES } from "../constants/pipeline.js";

const router = Router();

function requireAgentApi(req, res, next) {
  if (!req.user?.agent) {
    return res.status(403).json({ error: "agent_only_endpoint" });
  }
  next();
}

// Perimetro dati sempre legato all utente/token autenticato.
// Il query param tenant_id dei moduli satellite viene accettato e ignorato.
function siteIdOf(req) {
  return req.user?.site_id ?? null;
}

// Query param numerico opzionale: accettato solo se valido, altrimenti
// ignorato (evita errori di cast Postgres su input non numerico).
function intParamOf(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Categoria stage derivata dalla key (stessa semantica regex della spec):
// won/lost/open per i badge del modulo sales.
function categoryOfStageKey(key) {
  if (/(won|vinto|chiuso_vinto)/i.test(key)) return "won";
  if (/(lost|perso|chiuso_perso)/i.test(key)) return "lost";
  return "open";
}

// Palette deterministica per posizione: il CMS non memorizza colori per gli
// stadi (solo key/label), il sales li usa solo per la UI.
const STAGE_COLORS = ["#3B82F6", "#8B5CF6", "#F59E0B", "#10B981", "#EF4444", "#6B7280"];

// Opportunita per il modulo sales (cache locale + fallback offline).
router.get("/api/opportunities", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const siteId = siteIdOf(req);
    const params = [siteId];
    let sql = `
      SELECT
        o.id,
        o.title,
        o.amount::float8 AS value,
        o.stage,
        CASE WHEN o.status = 'won' THEN 'won'
             WHEN o.status = 'lost' THEN 'lost'
             ELSE 'open' END AS stage_category,
        COALESCE(NULLIF(o.contact_name, ''), latest_cr.contact_name, '') AS contact_name,
        COALESCE(NULLIF(o.contact_company, ''), '') AS contact_company,
        o.status,
        o.owner_id,
        CASE WHEN o.status = 'won' THEN o.expected_close_at END AS closed_at,
        o.updated_at AS synced_at
      FROM opportunities o
      LEFT JOIN LATERAL (
        SELECT cr.contact_name
        FROM call_recordings cr
        WHERE cr.opportunity_id = o.id AND cr.site_id = o.site_id
        ORDER BY cr.created_at DESC
        LIMIT 1
      ) latest_cr ON true
      WHERE o.site_id = $1
    `;
    const assignedTo = intParamOf(req.query.assigned_to);
    if (assignedTo !== null) {
      params.push(assignedTo);
      sql += ` AND o.owner_id = $${params.length}`;
    }
    sql += ` ORDER BY o.updated_at DESC`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Stage di pipeline per il modulo sales (badge open/won/lost).
// Nel CMS gli stadi NON sono una tabella: sono JSONB su pipelines.stages
// ([{key,label}]); se vuoti valgono i default della board (constants/pipeline.js),
// stessa logica di getBoard() in services/opportunities.js.
router.get("/api/pipeline", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const row = (await query(
      "SELECT id, name, stages, is_default FROM pipelines WHERE site_id = $1 ORDER BY is_default DESC, name LIMIT 1",
      [siteIdOf(req)]
    )).rows[0];
    let stages = [];
    try {
      const parsed = typeof row?.stages === "string" ? JSON.parse(row.stages) : row?.stages;
      if (Array.isArray(parsed)) stages = parsed;
    } catch { stages = []; }
    if (stages.length === 0) stages = PIPELINE_STAGES;
    res.json(stages.map((s, i) => ({
      key: String(s.key || ""),
      label: String(s.label || s.key || ""),
      color: STAGE_COLORS[i % STAGE_COLORS.length],
      position: i + 1,
      category: categoryOfStageKey(String(s.key || "")),
    })));
  } catch (err) { next(err); }
});

// Contatti (CRM-lite): name/company non esistono nello schema, si espongono a null.
router.get("/api/contacts", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, email, tags, status, NULL AS name, NULL AS company,
              created_at, updated_at
       FROM contacts WHERE site_id = $1
       ORDER BY updated_at DESC`,
      [siteIdOf(req)]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Preventivi con valore calcolato dalle righe items [{description, qty, price}].
// jsonb_typeof protegge da items non-array (jsonb_array_elements farebbe 500).
router.get("/api/quotes", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT q.id, q.quote_number, q.title, q.status, q.opportunity_id,
              (SELECT COALESCE(SUM(COALESCE((it->>'qty')::numeric, 0)
                    * COALESCE((it->>'price')::numeric, 0)), 0)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.items) = 'array'
                     THEN q.items ELSE '[]'::jsonb END) it)::float8 AS value,
              q.sent_at, q.signed_at, q.created_at
       FROM quotes q
       WHERE q.site_id = $1
       ORDER BY q.created_at DESC`,
      [siteIdOf(req)]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Agenda call per i closer del modulo sales.
router.get("/api/calendar", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const params = [siteIdOf(req)];
    let sql = `
      SELECT c.id, c.name AS title, c.scheduled_at, c.status,
             c.created_by AS closer_id, c.email AS contact_email
      FROM calls c
      WHERE c.site_id = $1
    `;
    const closerId = intParamOf(req.query.closer_id);
    if (closerId !== null) {
      params.push(closerId);
      sql += ` AND c.created_by = $${params.length}`;
    }
    sql += ` ORDER BY c.scheduled_at ASC`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Clienti attivi: contatti con tag customer/cliente, arricchiti con l ultimo
// nome noto dalle registrazioni chiamate (contact_company non esiste su
// call_recordings: company resta vuota finche il flusso sales non la
// denormalizza su opportunities). mrr resta 0: services_catalog non ha
// prezzi. last_order = ultimo preventivo firmato.
router.get("/api/customers", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ct.id, ct.email,
              COALESCE(latest_cr.contact_name, '') AS name,
              '' AS company,
              ct.status AS plan,
              0 AS mrr,
              (SELECT MAX(q.signed_at) FROM quotes q
               WHERE q.site_id = ct.site_id AND lower(q.contact_email) = lower(ct.email)) AS last_order,
              GREATEST(ct.updated_at,
                COALESCE((SELECT MAX(cr.created_at) FROM call_recordings cr
                          WHERE cr.site_id = ct.site_id
                            AND lower(cr.contact_email) = lower(ct.email)), ct.updated_at)) AS last_contact
       FROM contacts ct
       LEFT JOIN LATERAL (
         SELECT cr.contact_name
         FROM call_recordings cr
         WHERE cr.site_id = ct.site_id AND lower(cr.contact_email) = lower(ct.email)
         ORDER BY cr.created_at DESC LIMIT 1
       ) latest_cr ON true
       WHERE ct.site_id = $1 AND ('customer' = ANY(ct.tags) OR 'cliente' = ANY(ct.tags))
       ORDER BY ct.updated_at DESC`,
      [siteIdOf(req)]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Attivita recente di un cliente (vista aggregata semplice).
router.get("/api/customers/activity", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const customerId = intParamOf(req.query.customer_id);
    if (customerId === null) {
      return res.status(400).json({ error: "customer_id is required" });
    }
    const calls = (await query(
      `SELECT id, scheduled_at, status, outcome_notes
       FROM calls WHERE site_id = $1 AND email = (SELECT email FROM contacts WHERE id = $2 AND site_id = $1)
       ORDER BY scheduled_at DESC LIMIT 20`,
      [siteIdOf(req), customerId]
    )).rows;
    const quotes = (await query(
      `SELECT id, quote_number, status, signed_at
       FROM quotes WHERE site_id = $1 AND contact_email = (SELECT email FROM contacts WHERE id = $2 AND site_id = $1)
       ORDER BY created_at DESC LIMIT 20`,
      [siteIdOf(req), customerId]
    )).rows;
    res.json({ calls, quotes });
  } catch (err) { next(err); }
});

// Verdetto validita chiamata per il flusso di registrazione sales.
// Risposta SEMPRE 200 con oggetto flat (nessun wrapper): mapping
// valida si->valida, no->non_valida, dubbia/assente->in_attesa.
router.post("/api/call-verdict", requireAuth, requireAgentApi, async (req, res, next) => {
  try {
    const { cms_opportunity_id: opportunityId, audio_ref: audioRef } = req.body || {};
    if (!opportunityId) {
      return res.status(400).json({ error: "cms_opportunity_id is required" });
    }
    const params = [siteIdOf(req), opportunityId];
    let sql = `
      SELECT verdict FROM call_recordings
      WHERE site_id = $1 AND opportunity_id = $2
    `;
    if (audioRef) {
      params.push(String(audioRef));
      sql += ` AND (audio_path = $3 OR $3 = '')`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const row = (await query(sql, params)).rows[0];
    const v = row?.verdict || {};
    const esito = v.valida === "si" ? "valida"
      : v.valida === "no" ? "non_valida"
      : "in_attesa";
    res.json({
      esito_validita: esito,
      verdetto: v.motivazione || v.motivo_cap_classico || "",
      motivo: v.motivazione || null,
    });
  } catch (err) { next(err); }
});

export default router;
