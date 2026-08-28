import crypto from "crypto";
import config from "../config.js";
import { query } from "../db.js";
import { logger } from "./logger.js";
import { emitContactEvent } from "./events.js";
import { getCanonicalBaseUrl } from "./urls.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 38 — Link di pagamento Stripe (CRM nativo).
//
// Un link pubblico /pay/:token che il cliente apre per pagare. Se
// config.stripeSecretKey è valorizzato, createPaymentLink crea anche un
// Payment Link reale su Stripe (POST /v1/payment_links, timeout 15s) e la
// pagina pubblica reindirizza l'utente su Stripe; se la chiamata fallisce
// (o la chiave non c'è) il link resta in modalità 'draft' con stripe_url
// vuoto e la pagina pubblica mostra il form di conferma simulato — il link
// pubblico funziona comunque.
//
// Stati: draft → active (Stripe pronto) → paid | expired.
// Evento emesso: payment_paid (alimenta workflow/scoring/segmenti/webhook).
// ─────────────────────────────────────────────────────────────────────────

const VALID_STATUSES = ["draft", "active", "paid", "expired"];

function parseAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Postgres ritorna NUMERIC come stringa: normalizza a Number per l'API.
function mapPaymentLink(row) {
  if (!row) return row;
  return { ...row, amount: Number(row.amount) || 0 };
}

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Crea il Payment Link su Stripe. Parametri fissi: prezzo one-shot in
// centesimi, after_completion → redirect alla pagina pubblica /pay/:token
// (che mostrerà lo stato "completato"). Lancia in caso di errore HTTP o
// di rete; il chiamante gestisce il fallback alla modalità conferma.
async function createStripePaymentLink({ title, amount, currency, token, baseUrl }) {
  const body = new URLSearchParams();
  body.append("line_items[0][price_data][currency]", String(currency || "EUR").toUpperCase().slice(0, 3));
  body.append("line_items[0][price_data][product_data][name]", String(title || "Pagamento").slice(0, 255));
  body.append("line_items[0][price_data][unit_amount]", String(Math.round(parseAmount(amount) * 100)));
  body.append("line_items[0][quantity]", "1");
  body.append("after_completion[type]", "redirect");
  body.append("after_completion[redirect][url]", `${baseUrl}/pay/${token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch("https://api.stripe.com/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Stripe API ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const data = await resp.json();
    return String(data?.url || "");
  } finally {
    clearTimeout(timer);
  }
}

// ── Lettura ──────────────────────────────────────────────────────────────

export async function listPaymentLinks(siteId, { status = null, contactEmail = null, limit = 50, offset = 0 } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (status && VALID_STATUSES.includes(status)) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (contactEmail) {
    params.push(normalizeEmail(contactEmail));
    where += ` AND contact_email = $${params.length}`;
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = (await query(
    `SELECT * FROM payment_links WHERE ${where}
     ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`,
    params
  )).rows;
  return rows.map(mapPaymentLink);
}

export async function getPaymentLink(siteId, id) {
  const row = (await query(
    "SELECT * FROM payment_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  return mapPaymentLink(row || null);
}

export async function getPaymentLinkByToken(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const row = (await query(
    "SELECT * FROM payment_links WHERE token = $1",
    [t]
  )).rows[0];
  return mapPaymentLink(row || null);
}

// ── Scrittura ────────────────────────────────────────────────────────────

export async function createPaymentLink(siteId, { title, amount = 0, contact_email = "", description = "", currency = "EUR", opportunity_id = null } = {}) {
  const cleanTitle = String(title || "").trim().slice(0, 255);
  if (!cleanTitle) return null;

  const token = generateToken();
  let status = "draft";
  let stripeUrl = "";

  if (config.stripeSecretKey) {
    try {
      const baseUrl = await getCanonicalBaseUrl(siteId);
      stripeUrl = await createStripePaymentLink({ title: cleanTitle, amount, currency, token, baseUrl });
      if (stripeUrl) status = "active";
    } catch (err) {
      logger.error(`Stripe payment link fallito (site=${siteId}): ${err.message}`);
      stripeUrl = "";
      status = "draft";
    }
  }

  const row = (await query(
    `INSERT INTO payment_links
       (site_id, opportunity_id, contact_email, title, amount, currency, description, status, stripe_url, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [siteId, opportunity_id || null, normalizeEmail(contact_email).slice(0, 255),
     cleanTitle, parseAmount(amount), String(currency || "EUR").toUpperCase().slice(0, 3),
     String(description || "").slice(0, 5000), status, stripeUrl, token]
  )).rows[0];
  return mapPaymentLink(row);
}

export async function updatePaymentLink(siteId, id, data = {}) {
  const current = (await query(
    "SELECT * FROM payment_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (!current) return null;

  const fields = [];
  const params = [];
  if (data.title !== undefined) {
    const t = String(data.title).trim().slice(0, 255);
    if (t) { params.push(t); fields.push(`title = $${params.length}`); }
  }
  if (data.description !== undefined) {
    params.push(String(data.description).slice(0, 5000));
    fields.push(`description = $${params.length}`);
  }
  if (data.amount !== undefined) {
    params.push(parseAmount(data.amount));
    fields.push(`amount = $${params.length}`);
  }
  if (data.status !== undefined && VALID_STATUSES.includes(String(data.status))) {
    params.push(String(data.status));
    fields.push(`status = $${params.length}`);
  }

  if (fields.length === 0) return mapPaymentLink(current);

  params.push(parseInt(id, 10), siteId);
  await query(
    `UPDATE payment_links SET ${fields.join(", ")}, updated_at = NOW()
     WHERE id = $${params.length - 1} AND site_id = $${params.length}`,
    params
  );
  const row = (await query(
    "SELECT * FROM payment_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  return mapPaymentLink(row);
}

export async function deletePaymentLink(siteId, id) {
  const result = await query(
    "DELETE FROM payment_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  );
  return (result.rowCount || 0) > 0;
}

// ── Pagamento ────────────────────────────────────────────────────────────

// Porta il link a 'paid' (solo se era draft o active; se già paid ritorna
// {already:true} senza toccare paid_at). Emette l'evento 'payment_paid' se
// il link ha una contact_email. Eventuali errori dell'evento non devono
// mai far fallire il flusso di pagamento.
export async function markPaid(siteId, id, { by = "" } = {}) {
  const current = (await query(
    "SELECT * FROM payment_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (!current) return null;
  if (current.status === "paid") return { already: true, link: mapPaymentLink(current) };
  if (!["active", "draft"].includes(current.status)) {
    return { already: false, link: mapPaymentLink(current) };
  }

  await query(
    `UPDATE payment_links SET status = 'paid', paid_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND site_id = $2`,
    [parseInt(id, 10), siteId]
  );
  const row = (await query(
    "SELECT * FROM payment_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];

  if (row.contact_email) {
    try {
      await emitContactEvent(row.site_id, row.contact_email, "payment_paid", {
        payment_link_id: row.id,
        title: row.title,
        amount: Number(row.amount) || 0,
        currency: row.currency,
        by: String(by || ""),
      });
    } catch (err) {
      logger.error(`payment_paid event fallito (link=${row.id}): ${err.message}`);
    }
  }

  return { already: false, link: mapPaymentLink(row) };
}

// Usata dalla pagina pubblica POST /pay/:token/confirm: trova per token e
// marca come pagato se lo stato lo consente. {ok:true} = pagamento
// registrato (o già registrato), {ok:false} = token sconosciuto/scaduto.
export async function markPaidByToken(token, { by = "" } = {}) {
  const link = await getPaymentLinkByToken(token);
  if (!link) return { ok: false, link: null };
  if (link.status === "paid") return { ok: true, already: true, link };
  if (!["active", "draft"].includes(link.status)) return { ok: false, link };
  const result = await markPaid(link.site_id, link.id, { by });
  return { ok: true, already: false, link: result.link };
}
