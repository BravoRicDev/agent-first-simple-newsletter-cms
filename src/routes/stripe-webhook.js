import express, { Router } from "express";
import crypto from "crypto";
import config from "../config.js";
import { markPaidByToken } from "../services/payments.js";

// ─────────────────────────────────────────────────────────────────────────
// Webhook INGRESSO Stripe — POST /webhooks/stripe.
//
// Montato in src/index.js con express.raw({type:"application/json"}) PRIMA
// del body parser JSON globale: la firma Stripe copre i BYTE grezzi del
// body, quindi il payload non può essere parsato prima della verifica.
//
// Schema dell'header Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>...]".
// La firma è HMAC-SHA256(secret, "<t>.<body>"). Tolleranza timestamp 300s
// (anti-replay) e confronto in costante con crypto.timingSafeEqual.
//
// Per gli eventi che ci interessano:
//   - checkout.session.completed: processa solo se session.payment_status === 'paid'
//                                 e session.payment_link è presente; poi recupera
//                                 il Payment Link da Stripe API per leggere
//                                 metadata.token (il token del nostro link di
//                                 pagamento) e chiama markPaidByToken.
// ─────────────────────────────────────────────────────────────────────────

const TOLERANCE_SECONDS = 300;

// Estrae t e le firme v1 dal header "t=...,v1=...".
function parseSignatureHeader(header) {
  let timestamp = null;
  const v1 = [];
  for (const part of String(header || "").split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") timestamp = parseInt(value, 10);
    else if (key === "v1" && value) v1.push(value);
  }
  return { timestamp, v1 };
}

// Verifica la firma del webhook sul body RAW. 503 se il secret non è
// configurato, 400 se header/firma/timestamp non sono validi.
function verifyStripeSignature(req, res, next) {
  const secret = config.stripeWebhookSecret;
  if (!secret) {
    return res.status(503).json({ error: "Webhook Stripe non configurato" });
  }

  const header = req.headers["stripe-signature"];
  if (!header) {
    return res.status(400).json({ error: "Header Stripe-Signature mancante" });
  }

  const { timestamp, v1 } = parseSignatureHeader(header);
  if (!Number.isInteger(timestamp) || v1.length === 0) {
    return res.status(400).json({ error: "Header Stripe-Signature non valido" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TOLERANCE_SECONDS) {
    return res.status(400).json({ error: "Timestamp fuori dalla finestra di tolleranza" });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`, "utf8")
    .update(raw)
    .digest();

  const ok = v1.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    // timingSafeEqual pretende lunghezze uguali: una firma di lunghezza
    // diversa è già un mismatch, non un errore da far esplodere.
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
  });
  if (!ok) {
    return res.status(400).json({ error: "Firma Stripe non valida" });
  }

  next();
}

// Recupera il Payment Link da Stripe API dato il suo ID.
// Timeout 10s (AbortSignal.timeout) come le altre chiamate Stripe.
export async function fetchStripePaymentLink(paymentLinkId) {
  if (!config.stripeSecretKey) {
    throw new Error("Stripe secret key non configurata");
  }

  const resp = await fetch(
    `https://api.stripe.com/v1/payment_links/${encodeURIComponent(paymentLinkId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.stripeSecretKey}`,
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Stripe API ${resp.status}: ${detail.slice(0, 200)}`);
  }

  return await resp.json();
}

// handleStripeWebhook chiama la fetch ATTRAVERSO questa variabile, non
// direttamente fetchStripePaymentLink: su un export ESM non è possibile
// sostituire il binding, quindi i test non potrebbero stubbare la chiamata
// di rete. setStripePaymentLinkFetcher() la rimpiazza per il test.
let paymentLinkFetcher = fetchStripePaymentLink;

export function setStripePaymentLinkFetcher(fn) {
  paymentLinkFetcher = typeof fn === "function" ? fn : fetchStripePaymentLink;
}

// Estrae il token del link dai metadata del Payment Link di Stripe.
function extractTokenFromStripePaymentLink(stripePaymentLink) {
  return stripePaymentLink?.metadata?.token ?? null;
}

async function handleStripeWebhook(req, res, next) {
  try {
    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? ""));
    } catch {
      return res.status(400).json({ error: "Body non è JSON valido" });
    }

    // Gestiamo solo gli eventi che ci interessano realmente
    if (event.type === "checkout.session.completed") {
      const session = event.data?.object || {};

      // Processiamo solo pagamenti riusciti
      if (session.payment_status === "paid" && session.payment_link) {
        try {
          // Recuperiamo il Payment Link da Stripe per ottenere il nostro token
          const stripePaymentLink = await paymentLinkFetcher(session.payment_link);
          const token = extractTokenFromStripePaymentLink(stripePaymentLink);

          if (token) {
            // Marca il link come pagato tramite Stripe
            await markPaidByToken(token, { by: "stripe" });
          }
          // Se non troviamo il token, comunque rispondiamo 200 per non far ritentare Stripe
          // (il link potrebbe essere stato creato senza il nostro metadata)
        } catch (err) {
          // Se il recupero del Payment Link fallisce, rispondiamo 500 per far ritentare Stripe
          // come richiesto nelle specifiche
          console.error("Errore nel recupero del Payment Link da Stripe:", err.message);
          return res.status(500).json({ error: "Impossibile recuperare il Payment Link da Stripe" });
        }
      }
      // Se payment_status non è 'paid' o manca payment_link, ignoriamo l'evento
      // ma rispondiamo comunque 200 per non far ritentare Stripe inutilmente
    }
    // Per tutti gli altri eventi, rispondiamo 200 comunque

    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
}

const router = Router();

// express.raw DEVE precedere la verifica: la firma copre i byte grezzi.
router.post("/", express.raw({ type: "application/json" }), verifyStripeSignature, handleStripeWebhook);

export const stripeWebhookRouter = router;

// Router autonomo che applica anche il body parser, per i test che lo
// montano su app.use() senza il raw pre-montato in src/index.js.
export const stripeWebhookStandaloneRouter = Router();
stripeWebhookStandaloneRouter.post("/", express.raw({ type: "application/json" }), verifyStripeSignature, handleStripeWebhook);
