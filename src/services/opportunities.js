import crypto from "crypto";
import PDFDocument from "pdfkit";
import { query } from "../db.js";
import { logger } from "./logger.js";
import { PIPELINE_STAGES } from "../constants/pipeline.js";

// ─────────────────────────────────────────────────────────────────────────
// Opportunities (deals) and PDF quotes.
//
// - opportunities: vendita legata a un contatto, su una pipeline (stadi
//   custom), con importo e probabilità. Stato open/won/lost.
// - quotes: preventivo con righe items [{description, qty, price}], stato
//   draft → sent → viewed → signed, token pubblico per il link al cliente.
//   Il PDF è generato al volo con pdfkit (nessun file su disco, nessun
//   microservizio): basta il token per scaricarlo.
//
// Eventi emessi (fire-and-forget, alimentano workflow/scoring/segmenti):
//   opportunity_stage_changed, opportunity_status_changed,
//   quote_sent, quote_viewed, quote_signed.
// ─────────────────────────────────────────────────────────────────────────

function emit(siteId, email, eventType, payload) {
  import("./events.js").then(({ emitContactEvent }) =>
    emitContactEvent(siteId, email, eventType, payload)
  ).catch((err) => logger.error(`events emit fallito (${eventType}): ${err.message}`));
}

// Hook per il PUSH opzionale verso il CRM sorgente (GoHighLevel).
// Fire-and-forget; no-op se il push non è abilitato per il sito. `origin`
// implementa l'anti-echo (le mutate arrivate da GHL non vengono rispedite).
function pushOpportunity(siteId, id, options = {}) {
  if (!siteId || !id) return;
  import("./source-sync/push.js")
    .then(({ enqueuePush }) =>
      enqueuePush(siteId, "opportunity", { entityId: id, operation: options.operation || "upsert", externalId: options.externalId || "", origin: options.origin || "cms" })
    )
    .catch(() => {});
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function parseAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseProbability(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      description: String(it?.description || "").slice(0, 500),
      qty: Math.max(0, Number(it?.qty) || 1),
      price: parseAmount(it?.price),
    }))
    .filter((it) => it.description);
}

// Postgres ritorna NUMERIC come stringa: normalizza a numero per l'API.
function mapOpportunity(row) {
  if (!row) return row;
  return { ...row, amount: Number(row.amount) || 0 };
}

export function quoteTotal(items) {
  return (sanitizeItems(items)).reduce((sum, it) => sum + it.qty * it.price, 0);
}

// ── Opportunità ──────────────────────────────────────────────────────────

export async function listOpportunities(siteId, { status = null, stage = null, email = null } = {}) {
  const params = [siteId];
  let where = "o.site_id = $1";
  if (status && ["open", "won", "lost"].includes(status)) { params.push(status); where += ` AND o.status = $${params.length}`; }
  if (stage) { params.push(stage); where += ` AND o.stage = $${params.length}`; }
  if (email) { params.push(normalizeEmail(email)); where += ` AND o.contact_email = $${params.length}`; }
  const rows = (await query(
    `SELECT o.*, p.name AS pipeline_name,
            (SELECT COUNT(*)::int FROM quotes q WHERE q.opportunity_id = o.id) AS quotes_count
     FROM opportunities o
     LEFT JOIN pipelines p ON p.id = o.pipeline_id
     WHERE ${where} ORDER BY o.updated_at DESC`,
    params
  )).rows;
  return rows.map(mapOpportunity);
}

export async function getOpportunity(siteId, id) {
  const row = (await query(
    `SELECT o.*, p.name AS pipeline_name FROM opportunities o
     LEFT JOIN pipelines p ON p.id = o.pipeline_id
     WHERE o.id = $1 AND o.site_id = $2`,
    [parseInt(id, 10), siteId]
  )).rows[0];
  return mapOpportunity(row || null);
}

export async function createOpportunity(siteId, { email, pipeline_id = null, stage = "", title, amount = 0, probability = 0, expected_close_at = null, notes = "" } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !String(title || "").trim()) return null;
  const row = (await query(
    `INSERT INTO opportunities (site_id, contact_email, pipeline_id, stage, title, amount, probability, expected_close_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [siteId, normalized, pipeline_id || null, String(stage || "").slice(0, 100),
    String(title).trim().slice(0, 255), parseAmount(amount), parseProbability(probability),
    expected_close_at || null, String(notes || "").slice(0, 5000)]
    )).rows[0];
    emit(siteId, normalized, "opportunity_stage_changed", { opportunity_id: row.id, to_stage: row.stage, title: row.title });
    pushOpportunity(siteId, row.id);
    return mapOpportunity(row);
    }

export async function updateOpportunity(siteId, id, fields = {}) {
  const current = await getOpportunity(siteId, id);
  if (!current) return null;

  const stage = fields.stage !== undefined ? String(fields.stage || "").slice(0, 100) : current.stage;
  const status = fields.status !== undefined ? (["open", "won", "lost"].includes(fields.status) ? fields.status : current.status) : current.status;
  const title = fields.title !== undefined ? String(fields.title || "").trim().slice(0, 255) : current.title;
  const amount = fields.amount !== undefined ? parseAmount(fields.amount) : parseAmount(current.amount);
  const probability = fields.probability !== undefined ? parseProbability(fields.probability) : parseProbability(current.probability);
  const pipeline_id = fields.pipeline_id !== undefined ? (fields.pipeline_id || null) : current.pipeline_id;
  const expected_close_at = fields.expected_close_at !== undefined ? (fields.expected_close_at || null) : current.expected_close_at;
  const notes = fields.notes !== undefined ? String(fields.notes || "").slice(0, 5000) : current.notes;

  await query(
    `UPDATE opportunities SET stage = $1, status = $2, title = $3, amount = $4, probability = $5,
       pipeline_id = $6, expected_close_at = $7, notes = $8, updated_at = NOW()
     WHERE id = $9 AND site_id = $10`,
    [stage, status, title, amount, probability, pipeline_id, expected_close_at, notes, parseInt(id, 10), siteId]
  );

  if (stage !== current.stage) {
    emit(siteId, current.contact_email, "opportunity_stage_changed", { opportunity_id: current.id, from_stage: current.stage, to_stage: stage });
  }
  if (status !== current.status) {
    emit(siteId, current.contact_email, "opportunity_status_changed", { opportunity_id: current.id, from_status: current.status, to_status: status });
    // Opportunità vinta → il contatto diventa automaticamente cliente attivo
    // (area clienti generica). Solo se NON è già cliente: lo stato sospeso
    // gestito a mano dall'admin non viene sovrascritto da vecchie vittorie.
    if (status === "won" && current.contact_email) {
      await query(
        `UPDATE contacts SET is_client = true, client_status = 'active', updated_at = NOW()
         WHERE site_id = $1 AND LOWER(email) = LOWER($2) AND is_client = false`,
        [siteId, current.contact_email]
      ).catch(() => {});
    }
  }
  pushOpportunity(siteId, current.id);
  return getOpportunity(siteId, id);
}

export async function deleteOpportunity(siteId, id) {
  const row = await getOpportunity(siteId, id);
  if (!row) return 0;
  pushOpportunity(siteId, row.id, { operation: "delete", externalId: String(row.external_id || "") });
  await query("DELETE FROM opportunities WHERE id = $1 AND site_id = $2", [parseInt(id, 10), siteId]);
  emit(siteId, row.contact_email, "opportunity_deleted", { opportunity_id: parseInt(id, 10), title: row.title });
  return 1;
}

// ── Kanban board ─────────────────────────────────────────────────────────
// Vista "Pipelines": opportunità raggruppate per stage della
// pipeline selezionata. Nessuna nuova tabella: usa lo schema esistente.

// Pipeline del sito (con stages JSONB parse). Se stages è vuoto viene usato
// il vocabolario di default PIPELINE_STAGES (constants/pipeline.js).
export async function getBoardPipelines(siteId) {
  const rows = (await query(
    "SELECT id, name, stages, is_default FROM pipelines WHERE site_id = $1 ORDER BY is_default DESC, name",
    [siteId]
  )).rows;
  return rows.map((p) => {
    let stages = [];
    try {
      const parsed = typeof p.stages === "string" ? JSON.parse(p.stages) : p.stages;
      if (Array.isArray(parsed)) stages = parsed;
    } catch { stages = []; }
    return { id: p.id, name: p.name, is_default: p.is_default, stages };
  });
}

// Già importato come const per il default stages (vitale per la board).

// Dati della board: per ogni pipeline serve la lista stadi (custom o default),
// e le opportunità della pipeline raggruppate per stage. Ogni card porta anche
// nome contatto (JOIN contacts) e conteggio note recenti del contatto.
export async function getBoard(siteId, { pipelineId = null } = {}) {
  const pipelines = await getBoardPipelines(siteId);
  let targetPipeline = null;
  if (pipelineId) {
    targetPipeline = pipelines.find((p) => p.id === Number(pipelineId)) || null;
  }
  if (!targetPipeline) {
    targetPipeline = pipelines.find((p) => p.is_default) || pipelines[0] || null;
  }
  if (!targetPipeline) {
    return { pipelines, currentPipeline: null, board: [], stages: [] };
  }

  // Stadi della pipeline: custom se presenti, altrimenti default CRM.
  const stages = targetPipeline.stages && targetPipeline.stages.length > 0
    ? targetPipeline.stages
    : PIPELINE_STAGES;

  const rows = (await query(
    `SELECT o.*,
            COALESCE(cs.full_name, '') AS contact_name,
            (SELECT COUNT(*)::int FROM contact_notes n
              WHERE n.site_id = o.site_id AND n.contact_email = o.contact_email) AS notes_count
     FROM opportunities o
     LEFT JOIN LATERAL (
        SELECT fs.data->>'name' AS full_name
        FROM form_submissions fs
        WHERE fs.site_id = o.site_id AND LOWER(fs.data->>'email') = LOWER(o.contact_email)
        ORDER BY fs.created_at ASC
        LIMIT 1
     ) cs ON true
     WHERE o.site_id = $1 AND o.pipeline_id = $2
     ORDER BY o.updated_at DESC`,
    [siteId, targetPipeline.id]
  )).rows.map(mapOpportunity);

  // Raggruppa per stage: le card con stage non in lista finiscono in
  // "Da assegnare" (colonna extra in testa alla board).
  const stageKeys = stages.map((s) => s.key);
  const board = stages.map((s) => ({
    key: s.key,
    label: s.label,
    items: rows.filter((o) => o.stage === s.key),
  }));
  const unassigned = rows.filter((o) => !stageKeys.includes(o.stage));
  if (unassigned.length > 0) {
    board.unshift({ key: "__unassigned__", label: "Da assegnare", items: unassigned });
  }

  return { pipelines, currentPipeline: targetPipeline, board, stages };
}

// Sposta un'opportunità in uno stage (drag&drop). Lo status deriva dallo
// stage: 'vinto' → won, 'perso' → lost, altrimenti open. Aggiorna updated_at
// così la card torna in cima alla nuova colonna.
export async function moveOpportunityStage(siteId, id, { stage = "", pipeline_id = null } = {}) {
  const current = await getOpportunity(siteId, id);
  if (!current) return null;

  const targetStage = String(stage || "").slice(0, 100);
  let status = current.status;
  if (targetStage === "vinto") status = "won";
  else if (targetStage === "perso") status = "lost";
  else if (current.status === "won" || current.status === "lost") status = "open";
  // se il movimento è tra stadi "aperti" manteniamo lo status corrente

  const pipelineId = pipeline_id !== null && pipeline_id !== undefined && pipeline_id !== ""
    ? Number(pipeline_id) || null
    : current.pipeline_id;

  await query(
    `UPDATE opportunities SET stage = $1, status = $2, pipeline_id = $3, updated_at = NOW()
     WHERE id = $4 AND site_id = $5`,
    [targetStage, status, pipelineId, parseInt(id, 10), siteId]
  );

  if (targetStage !== current.stage) {
    emit(siteId, current.contact_email, "opportunity_stage_changed", { opportunity_id: current.id, from_stage: current.stage, to_stage: targetStage });
  }
  if (status !== current.status) {
    emit(siteId, current.contact_email, "opportunity_status_changed", { opportunity_id: current.id, from_status: current.status, to_status: status });
  }
  pushOpportunity(siteId, current.id);
  return getOpportunity(siteId, id);
}

// ── Preventivi ───────────────────────────────────────────────────────────

export async function getQuote(siteId, id) {
  const row = (await query(
    `SELECT q.*, o.title AS opportunity_title, o.stage AS opportunity_stage
     FROM quotes q LEFT JOIN opportunities o ON o.id = q.opportunity_id
     WHERE q.id = $1 AND q.site_id = $2`,
    [parseInt(id, 10), siteId]
  )).rows[0];
  return row || null;
}

export async function getQuoteByToken(token) {
  if (!token || typeof token !== "string") return null;
  const row = (await query(
    `SELECT q.*, o.title AS opportunity_title, o.stage AS opportunity_stage, s.name AS site_name
     FROM quotes q
     LEFT JOIN opportunities o ON o.id = q.opportunity_id
     JOIN sites s ON s.id = q.site_id
     WHERE q.token = $1`,
    [token]
  )).rows[0];
  return row || null;
}

export async function listQuotes(siteId, { status = null, email = null, opportunity_id = null } = {}) {
  const params = [siteId];
  let where = "q.site_id = $1";
  if (status) { params.push(status); where += ` AND q.status = $${params.length}`; }
  if (email) { params.push(normalizeEmail(email)); where += ` AND q.contact_email = $${params.length}`; }
  if (opportunity_id) { params.push(parseInt(opportunity_id, 10)); where += ` AND q.opportunity_id = $${params.length}`; }
  const rows = (await query(
    `SELECT q.* FROM quotes q WHERE ${where} ORDER BY q.created_at DESC`,
    params
  )).rows;
  return rows.map((r) => ({ ...r, total: quoteTotal(r.items) }));
}

export async function createQuote(siteId, { opportunity_id = null, contact_email, title = "", items = [], notes = "" } = {}) {
  const normalized = normalizeEmail(contact_email);
  if (!normalized) return null;

  const seq = (await query("SELECT nextval('quotes_number_seq') AS n")).rows[0].n;
  const quoteNumber = `Q-${String(seq).padStart(6, "0")}`;
  const token = crypto.randomBytes(32).toString("hex");

  const row = (await query(
    `INSERT INTO quotes (site_id, opportunity_id, contact_email, quote_number, title, items, notes, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [siteId, opportunity_id || null, normalized, quoteNumber,
     String(title || "").slice(0, 255), JSON.stringify(sanitizeItems(items)),
     String(notes || "").slice(0, 5000), token]
  )).rows[0];
  return { ...row, total: quoteTotal(row.items) };
}

export async function updateQuote(siteId, id, { title, items, notes, status } = {}) {
  const current = await getQuote(siteId, id);
  if (!current) return null;

  const newTitle = title !== undefined ? String(title || "").slice(0, 255) : current.title;
  const newItems = items !== undefined ? sanitizeItems(items) : current.items;
  const newNotes = notes !== undefined ? String(notes || "").slice(0, 5000) : current.notes;
  const newStatus = status !== undefined && ["draft", "sent", "viewed", "signed"].includes(status) ? status : current.status;

  await query(
    "UPDATE quotes SET title = $1, items = $2, notes = $3, status = $4, updated_at = NOW() WHERE id = $5 AND site_id = $6",
    [newTitle, JSON.stringify(newItems), newNotes, newStatus, parseInt(id, 10), siteId]
  );
  return getQuote(siteId, id);
}

// Cambia stato con timestamp + evento. sent → inviato al cliente (parte la
// notifica/il link); viewed → il cliente ha aperto la pagina; signed →
// conferma di accettazione.
export async function setQuoteStatus(siteId, id, status) {
  const current = await getQuote(siteId, id);
  if (!current) return null;
  if (!["draft", "sent", "viewed", "signed"].includes(status)) return null;
  if (current.status === status) return current;

  const now = new Date();
  const sets = { sent: "sent_at", viewed: "viewed_at", signed: "signed_at" };
  const col = sets[status];
  const extra = col ? `, ${col} = NOW()` : "";

  await query(
    `UPDATE quotes SET status = $1, updated_at = NOW()${extra} WHERE id = $2 AND site_id = $3`,
    [status, parseInt(id, 10), siteId]
  );

  const eventMap = { sent: "quote_sent", viewed: "quote_viewed", signed: "quote_signed" };
  if (eventMap[status]) {
    emit(siteId, current.contact_email, eventMap[status], {
      quote_id: current.id, quote_number: current.quote_number, title: current.title,
    });
  }
  return getQuote(siteId, id);
}

export async function deleteQuote(siteId, id) {
  return (await query("DELETE FROM quotes WHERE id = $1 AND site_id = $2", [parseInt(id, 10), siteId])).rowCount;
}

// ── PDF (pdfkit, generato al volo) ───────────────────────────────────────

const EUR = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

export function buildQuotePdf(quote, siteName = "") {
  const items = sanitizeItems(quote.items);
  const total = quoteTotal(items);
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });

  doc.fontSize(20).text("Preventivo", { align: "left" });
  doc.fontSize(11).fillColor("#666").text(`${quote.quote_number} — ${siteName || ""}`.trim(), { align: "left" });
  doc.moveDown();
  doc.fontSize(14).fillColor("#111").text(quote.title || "Preventivo");
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#666").text(`Data: ${new Date().toLocaleDateString("it-IT")}`);
  doc.text(`Cliente: ${quote.contact_email}`);
  if (quote.opportunity_title) doc.text(`Riferimento: ${quote.opportunity_title}`);
  doc.moveDown();

  // Tabella righe
  const startY = doc.y;
  doc.fontSize(10).fillColor("#333");
  doc.text("Descrizione", 48, startY);
  doc.text("Q.tà", 380, startY, { width: 40, align: "right" });
  doc.text("Prezzo", 430, startY, { width: 70, align: "right" });
  doc.text("Totale", 500, startY, { width: 70, align: "right" });
  doc.moveTo(48, startY + 14).lineTo(570, startY + 14).strokeColor("#ccc").stroke();

  let y = startY + 22;
  for (const it of items) {
    doc.text(it.description, 48, y, { width: 330 });
    doc.text(String(it.qty), 380, y, { width: 40, align: "right" });
    doc.text(EUR.format(it.price), 430, y, { width: 70, align: "right" });
    doc.text(EUR.format(it.qty * it.price), 500, y, { width: 70, align: "right" });
    y += 18;
    if (y > 740) { doc.addPage(); y = 60; }
  }

  doc.moveTo(48, y).lineTo(570, y).strokeColor("#ddd").stroke();
  doc.moveDown(0.5);
  doc.fontSize(13).fillColor("#111").text(`Totale: ${EUR.format(total)}`, { align: "right" });
  doc.moveDown();
  if (quote.notes) {
    doc.fontSize(10).fillColor("#555").text("Note:", 48);
    doc.text(quote.notes, 48, doc.y, { width: 500 });
  }
  doc.moveDown(2);
  doc.fontSize(9).fillColor("#999").text("Documento generato automaticamente — non richiede firma autografa. La conferma online vale come accettazione.", 48, doc.y, { width: 500 });

  doc.end();
  return doc; // stream leggibile
}
