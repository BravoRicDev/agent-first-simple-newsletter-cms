import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getQuoteByToken, setQuoteStatus, buildQuotePdf } from "../services/opportunities.js";

// ─────────────────────────────────────────────────────────────────────────
// Pagine pubbliche preventivi: il cliente riceve il link /quote/:token
// (via email o WhatsApp), apre la pagina (→ viewed), scarica il PDF,
// conferma l'accettazione (→ signed). Nessuna auth: il token è la chiave.
// Fix CORREZIONI-TRACCIATE: escape completo di tutti i campi renderizzati
// e rate limit sulle route pubbliche (martellabili con token casuali).
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// Limiter dedicato alle route pubbliche del preventivo: 20 richieste/min
// per IP (la pagina + pdf + sign di un cliente reale non superano mai
// questa soglia; blocca lo scraping con token casuali).
const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Troppe richieste, riprova tra un minuto" },
});

// Escape HTML completo ([&<>"']) — i campi del preventivo (title, number,
// site_name) possono contenere input arbitrario: la pagina è pubblica.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderQuotePage(req, res, quote, { signed = false, alreadySigned = false } = {}) {
  // items può essere NULL su righe importate/legacy (colonna jsonb): senza
  // guardia reduce/map crashavano con 500 su /quote/:token e /sign.
  const items = Array.isArray(quote.items) ? quote.items : [];
  const total = items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
  const fmt = (n) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(n) || 0);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const title = esc(quote.title || "Preventivo");
  const number = esc(quote.quote_number);
  const siteName = esc(quote.site_name || "");
  const safeItems = items.map(it => ({
    description: esc(it.description || ""),
    qty: Number(it.qty) || 1,
    price: Number(it.price) || 0,
  }));
  const notes = quote.notes ? esc(quote.notes) : "";
  res.send(`<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preventivo ${number}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f5f5f7;margin:0;padding:24px;color:#1c1c1e}
  .card{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;color:#666;font-weight:500;margin:0 0 20px}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  th{text-align:left;font-size:12px;color:#888;padding:8px 4px;border-bottom:1px solid #e5e5ea}
  td{padding:10px 4px;border-bottom:1px solid #f0f0f2;font-size:14px}
  .num{text-align:right} .total{font-size:18px;font-weight:700;text-align:right;margin:12px 0 20px}
  .btn{display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;border:none;cursor:pointer;margin-right:8px}
  .btn.ghost{background:#e5e5ea;color:#1c1c1e}
  .note{font-size:12px;color:#888;margin-top:20px;line-height:1.5}
  .badge{display:inline-block;padding:4px 10px;border-radius:99px;font-size:12px;background:#d1fae5;color:#065f46;margin-bottom:12px}
</style></head><body><div class="card">
  ${signed || alreadySigned ? '<div class="badge">✅ Preventivo accettato</div>' : ''}
  ${signed ? '<div class="badge" style="background:#dbeafe;color:#1e40af;">Grazie! Conferma registrata.</div>' : ''}
  <h1>${title}</h1>
  <h2>${number}${siteName ? " — " + siteName : ""}</h2>
  <table><thead><tr><th>Descrizione</th><th class="num">Q.tà</th><th class="num">Prezzo</th><th class="num">Totale</th></tr></thead><tbody>
    ${safeItems.map(it => `<tr><td>${it.description}</td><td class="num">${it.qty}</td><td class="num">${fmt(it.price)}</td><td class="num">${fmt(it.qty * it.price)}</td></tr>`).join("")}
  </tbody></table>
  <div class="total">Totale: ${fmt(total)}</div>
  ${notes ? `<div class="note"><strong>Note:</strong> ${notes}</div>` : ""}
  <div style="margin-top:16px;">
    <a class="btn" href="/quote/${quote.token}/pdf">📄 Scarica PDF</a>
    ${quote.status === "signed" ? "" : `<form method="POST" action="/quote/${quote.token}/sign" style="display:inline;">
      <button class="btn ghost" type="submit">✍️ Accetto il preventivo</button></form>`}
  </div>
  <div class="note">Questo documento è valido come proposta commerciale. La conferma online equivale ad accettazione del preventivo.</div>
</div></body></html>`);
}

// Pagina pubblica: al primo accesso (se non era già viewed/signed) passa a
// viewed e viene registrato l'evento quote_viewed.
router.get("/quote/:token", quoteLimiter, async (req, res, next) => {
  try {
    const quote = await getQuoteByToken(req.params.token);
    if (!quote) return res.status(404).send("Preventivo non trovato.");
    if (quote.status === "draft" || quote.status === "sent") {
      await setQuoteStatus(quote.site_id, quote.id, "viewed");
      quote.status = "viewed";
    }
    renderQuotePage(req, res, quote);
  } catch (err) { next(err); }
});

// PDF generato al volo (nessun file su disco).
router.get("/quote/:token/pdf", quoteLimiter, async (req, res, next) => {
  try {
    const quote = await getQuoteByToken(req.params.token);
    if (!quote) return res.status(404).send("Preventivo non trovato.");
    res.setHeader("Content-Type", "application/pdf");
    // Header injection guard: il filename va in Content-Disposition, quindi
    // solo caratteri sicuri (niente virgolette/CRLF da quote_number).
    const safeFilename = String(quote.quote_number || "preventivo").replace(/[^a-zA-Z0-9._-]/g, "");
    res.setHeader("Content-Disposition", `inline; filename="${safeFilename}.pdf"`);
    const doc = buildQuotePdf(quote, quote.site_name);
    // Stream error handler: senza listener, un EPIPE/errore PDFKit su un
    // client che si disconnette diventa uncaughtException → crash del processo.
    doc.on("error", (err) => {
      if (!res.headersSent) next(err); else res.destroy();
    });
    res.on("error", () => { try { doc.destroy(); } catch { /* già chiuso */ } });
    doc.pipe(res);
  } catch (err) { next(err); }
});

// Accettazione (firma online).
router.post("/quote/:token/sign", quoteLimiter, async (req, res, next) => {
  try {
    const quote = await getQuoteByToken(req.params.token);
    if (!quote) return res.status(404).send("Preventivo non trovato.");
    const alreadySigned = quote.status === "signed";
    if (!alreadySigned) {
      await setQuoteStatus(quote.site_id, quote.id, "signed");
      quote.status = "signed";
    }
    renderQuotePage(req, res, quote, { signed: !alreadySigned, alreadySigned });
  } catch (err) { next(err); }
});

export default router;
