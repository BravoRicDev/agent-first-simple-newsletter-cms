import { Router } from "express";
import { getPaymentLinkByToken, markPaidByToken } from "../services/payments.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 38 — Pagina PUBBLICA del link di pagamento (/pay/:token).
//
// Nessuna auth: il token nel path è la chiave (stesso modello di
// /quote/:token). Comportamento:
//   - status draft/active + stripe_url valorizzato → bottone "Paga con
//     Stripe" (redirect al Payment Link reale, after_completion torna qui);
//   - status draft/active senza stripe_url → modalità simulata: form POST
//     /pay/:token/confirm con bottone "Conferma pagamento";
//   - status paid → "Pagamento completato";
//   - status expired → "Link scaduto";
//   - token sconosciuto → 404.
// Il padre monta questo modulo in src/index.js (app.use) prima del
// catch-all dei siti pubblici; qui si usa res.send() diretto, niente
// layout EJS. Il valore di ritorno di Stripe è già un URL HTTPS validato
// da Stripe; l'attributo rel="noopener noreferrer" è difensivo.
// ─────────────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtAmount(n, currency = "EUR") {
  try {
    return new Intl.NumberFormat("it-IT", { style: "currency", currency }).format(Number(n) || 0);
  } catch {
    return `${Number(n) || 0} ${currency}`;
  }
}

function renderPayPage(res, link) {
  const paid = link.status === "paid";
  const expired = link.status === "expired";
  const canStripe = (link.status === "draft" || link.status === "active") && link.stripe_url;

  let badge = "";
  if (paid) badge = '<div class="badge ok">✅ Pagamento completato</div>';
  else if (expired) badge = '<div class="badge warn">⏳ Link scaduto</div>';
  else if (link.status === "active") badge = '<div class="badge">🔒 Pagamento sicuro via Stripe</div>';

  const action = paid
    ? '<div class="note">Grazie! Il pagamento è stato registrato. Riceverai la conferma via email.</div>'
    : expired
      ? '<div class="note">Questo link di pagamento non è più valido. Contatta chi te lo ha inviato.</div>'
      : canStripe
        ? `<a class="btn" href="${esc(link.stripe_url)}" rel="noopener noreferrer" target="_blank">💳 Paga con Stripe</a>`
        : `<form method="POST" action="/pay/${esc(link.token)}/confirm">
             <button class="btn" type="submit">Conferma pagamento</button>
           </form>
           <div class="note">Modalità simulata: nessun addebito reale (Stripe non configurato).</div>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagamento — ${esc(link.title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f5f5f7;margin:0;padding:24px;color:#1c1c1e}
  .card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;color:#666;font-weight:500;margin:0 0 20px}
  .amount{font-size:32px;font-weight:700;margin:8px 0 16px}
  .desc{font-size:14px;color:#444;line-height:1.5;margin-bottom:20px}
  .btn{display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:600;border:none;cursor:pointer}
  .badge{display:inline-block;padding:4px 10px;border-radius:99px;font-size:12px;background:#dbeafe;color:#1e40af;margin-bottom:12px}
  .badge.ok{background:#d1fae5;color:#065f46}
  .badge.warn{background:#fef3c7;color:#92400e}
  .note{font-size:12px;color:#888;margin-top:20px;line-height:1.5}
</style></head><body><div class="card">
  ${badge}
  <h1>${esc(link.title)}</h1>
  <div class="amount">${esc(fmtAmount(link.amount, link.currency))}</div>
  ${link.description ? `<div class="desc">${esc(link.description)}</div>` : ""}
  ${action}
  <div class="note">Hai domande? Contatta chi ti ha inviato questo link.</div>
</div></body></html>`);
}

const router = Router();

// Pagina pubblica del link di pagamento.
async function payPageHandler(req, res, next) {
  try {
    const link = await getPaymentLinkByToken(req.params.token);
    if (!link) return res.status(404).send("Link di pagamento non trovato.");
    renderPayPage(res, link);
  } catch (err) { next(err); }
}

// Conferma simulata (modalità senza Stripe): marca come pagato e torna
// alla pagina che mostra lo stato completato.
async function confirmHandler(req, res, next) {
  try {
    const result = await markPaidByToken(req.params.token, { by: "public-page" });
    if (!result.ok) return res.status(404).send("Link di pagamento non trovato o non più valido.");
    res.redirect(302, `/pay/${req.params.token}`);
  } catch (err) { next(err); }
}

router.get("/pay/:token", payPageHandler);
router.post("/pay/:token/confirm", confirmHandler);

// Registrazione sul router del chiamante (il padre monta questo modulo in
// src/index.js). Stessi handler del router autonomo qui sotto.
export function registerPublicPaymentsRoutes(router) {
  router.get("/pay/:token", payPageHandler);
  router.post("/pay/:token/confirm", confirmHandler);
}

// Router autonomo esportato per i test e per app.use(publicPaymentsRouter).
export const publicPaymentsRouter = Router();
registerPublicPaymentsRoutes(publicPaymentsRouter);
