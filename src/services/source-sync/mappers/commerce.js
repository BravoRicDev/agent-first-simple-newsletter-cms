import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";

// ─────────────────────────────────────────────────────────────────────────
// Mapper "commerce" (Products / Invoices / Payments) verso CRM sorgente.
//
// Allineamento alla documentazione ufficiale CRM sorgente versione 2021-07-28
// (header `Version: 2021-07-28` inviato dal client, v. client.js). Fonti
// verificate in questa sessione (SENZA account CRM sorgente live):
//   - Invoices (Version: 2021-07-28 esplicito nei doc): GET /invoices/ torna
//     { invoices: [...], total }. Ogni invoice usa `_id` (NON `id`),
//     `contactDetails` (oggetto annidato con `.id`, NON `contactId` flat),
//     `invoiceItems` (NON `items`), `invoiceNumber` è un NUMERO,
//     `status` ∈ {draft, sent, payment_processing, paid, void, partially_paid},
//     `termsNotes` (NON `notes`), `createdAt`/`updatedAt`.
//   - Products (Version: 2021-07-28): GET /products?locationId torna
//     { products: [...] }. Ogni product usa `_id`, `productType`
//     (enum DIGITAL/PHYSICAL/SERVICE/PHYSICAL-DIGITAL, MAI `type`),
//     `createdAt`/`updatedAt` (NON dateAdded/dateUpdated). I prezzi NON sono
//     annidati nel product: stanno in GET /products/:id/prices (risorsa a
//     parte) e usano `type` (one_time/recurring, MAI `billingType`),
//     `amount`, `currency`, `createdAt`/`updatedAt`.
//
// Parti NON verificabili con certezza (→ "da verificare con dati live", v.
// report bugfix-reports/commerce-sync-parity.md):
//   - La shape esatta di `invoiceItems` nella risposta LIST: i doc mostrano
//     la lista che ritorna `invoiceItems` come string[] (solo ID). Se così
//     fosse, servirebbe un GET /invoices/:id per ogni fattura per avere gli
//     oggetti riga. Il mapper gestisce sia oggetti che ID (salta gli ID).
//   - `paidAt` / `stripeLink`: nessun campo omonimo documentato sull'invoice
//     (c'è `amountPaid` numerico e `paymentMethods.stripe`). Lasciati come
//     fallback opzionali.
//   - L'intera sezione "payments" (GET /payments → payment_links): la doc
//     ufficiale 2021-07-28 NON espone un endpoint /payments con questa shape
//     (il modulo Payments copre config/orders/subscriptions/transactions).
//     Codice mantenuto per non peggiorare, ma da verificare con dati live.
// ─────────────────────────────────────────────────────────────────────────

const PRODUCT_TYPE_ENUM = ["physical", "digital", "service"];
function normalizeProductType(v) {
  const s = String(v || "physical").trim().toLowerCase();
  if (PRODUCT_TYPE_ENUM.includes(s)) return s;
  // CRM sorgente productType enum: DIGITAL, PHYSICAL, SERVICE, PHYSICAL/DIGITAL
  if (s.includes("digital") && s.includes("physical")) return "physical"; // ambiguo → default
  if (s.includes("digital")) return "digital";
  if (s.includes("service")) return "service";
  return "physical";
}

const INVOICE_STATUS_ENUM = ["draft", "sent", "paid", "void"];
function normalizeInvoiceStatus(v) {
  const s = String(v || "draft").toLowerCase();
  if (INVOICE_STATUS_ENUM.includes(s)) return s;
  // Stati CRM sorgente extra non rappresentabili nella colonna DB: si accorciano a "sent"
  // (inviata ma non saldata) per non perderli del tutto.
  if (s === "payment_processing" || s === "partially_paid") return "sent";
  return "draft";
}

async function ensureUniqueInvoiceNumber(siteId, baseNumber) {
  let invoiceNumber = baseNumber;
  let attempt = 0;
  while (attempt < 100) {
    const existing = await query(
      "SELECT id FROM invoices WHERE site_id = $1 AND invoice_number = $2 LIMIT 1",
      [siteId, invoiceNumber]
    );
    if (existing.rows.length === 0) return invoiceNumber;
    const suffix = "-" + Math.random().toString(36).slice(2, 5).toUpperCase();
    invoiceNumber = baseNumber + suffix;
    attempt++;
  }
  throw new Error(`Impossibile generare numero fattura univoco per ${baseNumber}`);
}

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    // ── Products ─────────────────────────────────────────────────────────
    // GET /products?locationId (doc 2021-07-28). Response { products: [...] }.
    const productsRes = await client.get("/products", { locationId: cfg.location_id });
    const products = Array.isArray(productsRes) ? productsRes : productsRes?.products || [];
    addStat("commerce", "fetched", products.length);

    const productMap = {};

    if (!dryRun) {
      for (const product of products) {
        try {
          const prodId = product._id || product.id;
          const cols = {
            name: product.name || "",
            description: product.description || "",
            // CRM sorgente: productType (DIGITAL/PHYSICAL/SERVICE/…), mai `type`.
            product_type: normalizeProductType(product.productType || product.type),
            // Il product CRM sorgente non espone un flag `active`: default true.
            active: product.active !== false,
          };
          // CRM sorgente usa createdAt/updatedAt, non dateAdded/dateUpdated.
          const timestamps = {
            createdAt: product.createdAt || product.dateAdded,
            updatedAt: product.updatedAt || product.dateUpdated,
          };

          const { row, action } = await upsertByExternalId({
            table: "products",
            siteId,
            externalId: prodId,
            cols,
            timestamps,
          });

          if (action === "inserted") addStat("commerce", "upserted", 1);
          else if (action === "updated") addStat("commerce", "updated", 1);
          else addStat("commerce", "skipped", 1);

          if (row) productMap[prodId] = row.id;

          // Prezzi: nel list-response CRM sorgente non sono annidati; stanno in
          // GET /products/:id/prices (risorsa a parte, da verificare live).
          // Leggiamo comunque un eventuale array annidato `prices` come
          // fallback (mantiene compatibilità con i mock/test esistenti).
          const prices = Array.isArray(product.prices) ? product.prices : [];
          for (const price of prices) {
            try {
              const priceCols = {
                product_id: row?.id || null,
                name: price.name || "Standard",
                amount: parseFloat(price.amount || 0),
                currency: price.currency || "EUR",
                // CRM sorgente price usa `type` (one_time/recurring), non `billingType`.
                billing_type: String(price.type || price.billingType || "one_time").toLowerCase(),
                active: price.active !== false,
              };
              const priceTimestamps = {
                createdAt: price.createdAt || price.dateAdded,
                updatedAt: price.updatedAt || price.dateUpdated,
              };

              const { action: priceAction } = await upsertByExternalId({
                table: "product_prices",
                siteId,
                externalId: price._id || price.id,
                cols: priceCols,
                timestamps: priceTimestamps,
              });

              if (priceAction === "inserted") addStat("commerce", "upserted", 1);
              else if (priceAction === "updated") addStat("commerce", "updated", 1);
              else addStat("commerce", "skipped", 1);
            } catch (err) {
              addStat("commerce", "errors", 1);
              log(`product_price ${price?._id || price?.id}: ${err.message}`);
            }
          }
        } catch (err) {
          addStat("commerce", "errors", 1);
          log(`product ${product?._id || product?.id}: ${err.message}`);
        }
      }
    } else {
      addStat("commerce", "upserted", products.length);
    }

    // ── Invoices ──────────────────────────────────────────────────────────
    // GET /invoices/ (doc 2021-07-28, Version header obbligatorio): richiede
    // altId + altType (NON locationId). Response { invoices: [...], total }.
    const invoicesRes = await client.get("/invoices", {
      altId: cfg.location_id,
      altType: "location",
    });
    const invoices = Array.isArray(invoicesRes) ? invoicesRes : invoicesRes?.invoices || [];
    addStat("commerce", "fetched", invoices.length);

    if (!dryRun) {
      for (const invoice of invoices) {
        try {
          const invId = invoice._id || invoice.id;
          // CRM sorgente: contactDetails.id (oggetto annidato), non contactId flat.
          const srcContactId = invoice.contactDetails?.id || invoice.contactId || null;
          const contactId = srcContactId
            ? await findInternalId("contacts", siteId, srcContactId)
            : null;

          // invoiceNumber di CRM sorgente è un NUMERO: normalizziamo a stringa.
          const baseNumber = invoice.invoiceNumber != null ? String(invoice.invoiceNumber) : "INV-" + Date.now();
          const invoiceNumber = await ensureUniqueInvoiceNumber(siteId, baseNumber);

          const cols = {
            contact_id: contactId,
            invoice_number: invoiceNumber,
            // DB ammette solo draft/sent/paid/void; CRM sorgente ne ha di più.
            status: normalizeInvoiceStatus(invoice.status),
            currency: invoice.currency || "EUR",
            issue_date: invoice.issueDate,
            due_date: invoice.dueDate,
            total: parseFloat(invoice.total || 0),
            // CRM sorgente: termsNotes (non `notes`).
            notes: invoice.termsNotes || invoice.notes || "",
            // Nessun campo `stripeLink` documentato: fallback opzionale.
            stripe_payment_link: invoice.stripePaymentLink || invoice.stripeLink || "",
          };
          const timestamps = {
            createdAt: invoice.createdAt || invoice.dateAdded,
            updatedAt: invoice.updatedAt || invoice.dateUpdated,
          };

          const { row, action } = await upsertByExternalId({
            table: "invoices",
            siteId,
            externalId: invId,
            cols,
            timestamps,
          });

          if (action === "inserted") addStat("commerce", "upserted", 1);
          else if (action === "updated") addStat("commerce", "updated", 1);
          else addStat("commerce", "skipped", 1);

          // paid_at solo se lo status è paid E CRM sorgente fornisce un paidAt (raro:
          // l'invoice CRM sorgente doc non espone paidAt, ma lo gestiamo se presente).
          if (row && cols.status === "paid" && invoice.paidAt) {
            await query(
              "UPDATE invoices SET paid_at = $1 WHERE id = $2",
              [invoice.paidAt, row.id]
            );
          }

          // Invoice items: CRM sorgente `invoiceItems` (non `items`). Nella LIST il
          // campo può essere un array di ID (string[]) → li saltiamo; se sono
          // oggetti li processiamo. Da verificare con dati live.
          const items = Array.isArray(invoice.invoiceItems)
            ? invoice.invoiceItems
            : Array.isArray(invoice.items)
            ? invoice.items
            : [];
          for (const item of items) {
            try {
              if (typeof item === "string") continue; // lista ritorna solo ID
              const itemId = item.id || item._id;
              const existing = (
                await query(
                  "SELECT id FROM invoice_items WHERE external_id = $1 LIMIT 1",
                  [itemId]
                )
              ).rows[0];

              if (!existing && !dryRun) {
                const qty = parseFloat(item.qty ?? item.quantity ?? 1);
                const unit = parseFloat(item.amount ?? item.unitPrice ?? 0);
                const tot = parseFloat(item.total ?? item.amount ?? item.unitPrice ?? 0);
                await query(
                  `INSERT INTO invoice_items (external_id, invoice_id, description, quantity, unit_price, total, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    itemId,
                    row?.id || null,
                    item.description || item.name || "",
                    qty,
                    unit,
                    tot,
                    item.dateAdded || item.createdAt || invoice.createdAt || invoice.dateAdded || new Date(),
                  ]
                );
              }
              addStat("commerce", "upserted", existing ? 0 : 1);
            } catch (err) {
              addStat("commerce", "errors", 1);
              log(`invoice_item ${item?.id || item?._id}: ${err.message}`);
            }
          }
        } catch (err) {
          addStat("commerce", "errors", 1);
          log(`invoice ${invoice?._id || invoice?.id}: ${err.message}`);
        }
      }
    } else {
      addStat("commerce", "upserted", invoices.length);
    }

    // ── Payments ──────────────────────────────────────────────────────────
    // ⚠️ DA VERIFICARE CON DATI LIVE: la doc ufficiale 2021-07-28 NON espone
    // un GET /payments con questa shape (payment_links). Mantenuto per non
    // peggiorare; i nomi campo seguono l'assunto storico del mapper.
    const paymentsRes = await client.get("/payments", { locationId: cfg.location_id });
    const payments = Array.isArray(paymentsRes) ? paymentsRes : paymentsRes?.payments || [];
    addStat("commerce", "fetched", payments.length);

    if (!dryRun) {
      for (const payment of payments) {
        try {
          const cols = {
            title: payment.title || "",
            amount: parseFloat(payment.amount || 0),
            currency: payment.currency || "EUR",
            contact_email: payment.contactEmail || payment.email || "",
            status: ["paid", "active", "expired"].includes(payment.status) ? payment.status : "draft",
            stripe_url: payment.url || "",
          };
          const timestamps = {
            createdAt: payment.dateAdded,
            updatedAt: payment.dateUpdated,
          };

          const { row, action } = await upsertByExternalId({
            table: "payment_links",
            siteId,
            externalId: payment.id,
            cols,
            timestamps,
          });

          if (action === "inserted") addStat("commerce", "upserted", 1);
          else if (action === "updated") addStat("commerce", "updated", 1);
          else addStat("commerce", "skipped", 1);

          if (row && cols.status === "paid" && payment.paidAt) {
            await query(
              "UPDATE payment_links SET paid_at = $1 WHERE id = $2",
              [payment.paidAt, row.id]
            );
          }
        } catch (err) {
          addStat("commerce", "errors", 1);
          log(`payment_link ${payment.id}: ${err.message}`);
        }
      }
    } else if (payments.length > 0) {
      addStat("commerce", "upserted", payments.length);
    }
  } catch (err) {
    addStat("commerce", "errors", 1);
    log(`syncAll commerce fallito: ${err.message}`);
    throw err;
  }
}
