import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda H: Commerce clone — products, invoices, coupons, items.
describe("Onda H — Commerce clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let contact;
  let coupon;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = res.ok ? await res.json() : null;
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Commerce Clone");
    apiKey = await mkKey(site.id, "test key");

    // Crea contatto di test
    const contactEmail = `contact-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const contactResult = await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
      [site.id, contactEmail]
    );
    contact = { id: contactResult.rows[0].id, externalId: contactResult.rows[0].external_id };
    if (!contact.externalId) {
      const extResult = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
      contact.externalId = extResult.rows[0].external_id;
    }

    // Crea coupon di test
    const couponResult = await query(
      `INSERT INTO coupons (site_id, code, discount_type, discount_value, active)
       VALUES ($1, 'SAVE10', 'percent', 10, true)
       RETURNING id, external_id`,
      [site.id]
    );
    coupon = { id: couponResult.rows[0].id, externalId: couponResult.rows[0].external_id };
    if (!coupon.externalId) {
      const extResult = await query("SELECT external_id FROM coupons WHERE id = $1", [coupon.id]);
      coupon.externalId = extResult.rows[0].external_id;
    }

    // Crea app express
    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      console.error("Server error:", err.message, err.stack);
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  // ── Products ──────────────────────────────────────────────────────────

  test("Product: create con 2 prezzi → list meta → get → update prezzi replace → delete", async () => {
    // Create con 2 prezzi
    const createRes = await fetch("/products", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Product",
        description: "A test product",
        type: "physical",
        prices: [
          { name: "Standard", amount: 100, currency: "EUR", billingType: "one_time" },
          { name: "Premium", amount: 150, currency: "EUR", billingType: "one_time" }
        ]
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.product);
    assert(createRes.data.product.id);
    assert.equal(createRes.data.product.name, "Test Product");
    assert.equal(createRes.data.product.type, "physical");
    assert.equal(createRes.data.product.prices.length, 2);
    assert.equal(createRes.data.product.prices[0].name, "Standard");
    assert.equal(createRes.data.product.prices[0].amount, 100);
    assert.equal(createRes.data.product.prices[1].name, "Premium");
    assert.equal(createRes.data.product.prices[1].amount, 150);
    const productId = createRes.data.product.id;

    // List con meta
    const listRes = await fetch("/products");
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.products));
    assert(listRes.data.meta);
    assert(typeof listRes.data.meta.total === "number");
    assert.equal(listRes.data.meta.total >= 1, true);

    // Get
    const getRes = await fetch(`/products/${productId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.product.id, productId);
    assert.equal(getRes.data.product.prices.length, 2);

    // Update con sostituzione prezzi (1 nuovo prezzo)
    const updateRes = await fetch(`/products/${productId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Updated Product",
        prices: [
          { name: "Solo", amount: 200, currency: "EUR", billingType: "one_time" }
        ]
      }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.product.name, "Updated Product");
    assert.equal(updateRes.data.product.prices.length, 1);
    assert.equal(updateRes.data.product.prices[0].amount, 200);

    // Delete
    const deleteRes = await fetch(`/products/${productId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);

    // Verify delete
    const getAfterDelRes = await fetch(`/products/${productId}`);
    assert.equal(getAfterDelRes.status, 404);
  });

  // ── Invoices ──────────────────────────────────────────────────────────

  test("Invoice: create con 2 righe (totale verificato) → list filtro status → put status paid → delete draft", async () => {
    // Create con 2 items
    const createRes = await fetch("/invoices", {
      method: "POST",
      body: JSON.stringify({
        contactId: contact.externalId,
        items: [
          { description: "Service A", quantity: 1, unitPrice: 100 },
          { description: "Service B", quantity: 2, unitPrice: 50 }
        ],
        dueDate: "2026-09-25",
        notes: "Test invoice"
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.invoice);
    assert(createRes.data.invoice.id);
    assert.equal(createRes.data.invoice.status, "draft");
    assert.equal(createRes.data.invoice.contactId, contact.externalId);
    assert.equal(createRes.data.invoice.items.length, 2);
    // Totale = 100 + (2 * 50) = 200
    assert.equal(createRes.data.invoice.total, 200);
    assert.equal(createRes.data.invoice.items[0].total, 100);
    assert.equal(createRes.data.invoice.items[1].total, 100);
    assert.equal(createRes.data.invoice.invoiceNumber.startsWith("SITE"), true);
    const invoiceId = createRes.data.invoice.id;

    // List con filtro status draft
    const listRes = await fetch("/invoices?status=draft");
    if (listRes.status !== 200) {
      console.error("List invoices failed with status", listRes.status, "data:", listRes.data);
    }
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.invoices));
    assert(listRes.data.meta);
    const draftInvoices = listRes.data.invoices.filter(i => i.id === invoiceId);
    assert.equal(draftInvoices.length, 1);

    // Get
    const getRes = await fetch(`/invoices/${invoiceId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.invoice.status, "draft");
    assert.equal(getRes.data.invoice.items.length, 2);

    // Update status a paid
    const updateRes = await fetch(`/invoices/${invoiceId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "paid" }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.invoice.status, "paid");
    assert(updateRes.data.invoice.paidAt !== null);

    // Verifica con get
    const getAfterPaidRes = await fetch(`/invoices/${invoiceId}`);
    assert.equal(getAfterPaidRes.status, 200);
    assert.equal(getAfterPaidRes.status, 200);
    assert.equal(getAfterPaidRes.data.invoice.status, "paid");
  });

  test("Invoice: coupon applicato come riga negativa, totale ridotto", async () => {
    // Create con coupon
    const createRes = await fetch("/invoices", {
      method: "POST",
      body: JSON.stringify({
        items: [
          { description: "Item 1", quantity: 1, unitPrice: 100 }
        ],
        couponCode: "SAVE10"
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.invoice);
    const invoice = createRes.data.invoice;

    // Total dovrebbe essere 100 - 10 (10% di sconto) = 90
    assert.equal(invoice.total, 90);
    // Items dovrebbe avere la riga originale + riga sconto
    assert.equal(invoice.items.length, 2);
    assert.equal(invoice.items[0].description, "Item 1");
    assert.equal(invoice.items[0].total, 100);
    assert.equal(invoice.items[1].description.includes("Sconto"), true);
    assert.equal(invoice.items[1].total, -10);
  });

  test("Invoice: delete solo in stato draft", async () => {
    // Create
    const createRes = await fetch("/invoices", {
      method: "POST",
      body: JSON.stringify({
        items: [
          { description: "Item", quantity: 1, unitPrice: 50 }
        ]
      }),
    });
    const invoiceId = createRes.data.invoice.id;

    // Update a paid
    await fetch(`/invoices/${invoiceId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "paid" }),
    });

    // Tentativo di delete su fattura paid → deve fallire
    const deleteRes = await fetch(`/invoices/${invoiceId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 404);

    // Create nuovo invoice in draft
    const createRes2 = await fetch("/invoices", {
      method: "POST",
      body: JSON.stringify({
        items: [
          { description: "Item", quantity: 1, unitPrice: 50 }
        ]
      }),
    });
    const invoiceId2 = createRes2.data.invoice.id;

    // Delete su draft → successo
    const deleteRes2 = await fetch(`/invoices/${invoiceId2}`, { method: "DELETE" });
    assert.equal(deleteRes2.status, 200);
    assert.equal(deleteRes2.data.deleted, true);
  });

  // ── Parity ghl_id (round 13) ──────────────────────────────────────────

  test("Parity ghl_id: round-trip GET/PUT/DELETE product col ghl_id reale", async () => {
    const createRes = await fetch("/products", {
      method: "POST",
      body: JSON.stringify({
        name: "RtProduct",
        prices: [{ name: "Std", amount: 42, currency: "EUR", billingType: "one_time" }],
      }),
    });
    assert.equal(createRes.status, 201);
    const uuidId = createRes.data.product.id;

    const realGhlId = "ghlPRODparity000001";
    await query("UPDATE products SET ghl_id = $1 WHERE external_id = $2", [realGhlId, uuidId]);

    // GET col ghl_id reale → 200 e id = ghl_id reale
    const getRes = await fetch(`/products/${realGhlId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.product.id, realGhlId, "id risposta deve essere il ghl_id reale");

    // PUT col ghl_id reale
    const putRes = await fetch(`/products/${realGhlId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "RtProduct Updated" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.product.name, "RtProduct Updated");
    assert.equal(putRes.data.product.id, realGhlId);
    // Anello dei prezzi: anche il price id è esposto col proprio ghl_id/UUID
    assert.ok(putRes.data.product.prices[0].id);

    // Ancora raggiungibile col vecchio UUID interno
    const getByUuid = await fetch(`/products/${uuidId}`);
    assert.equal(getByUuid.status, 200);
    assert.equal(getByUuid.data.product.id, realGhlId, "UUID interno risolve, ma id resta il ghl_id");

    // DELETE col ghl_id reale
    const delRes = await fetch(`/products/${realGhlId}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const goneRes = await fetch(`/products/${realGhlId}`);
    assert.equal(goneRes.status, 404);
  });

  test("Parity ghl_id: round-trip GET/PUT/DELETE invoice col ghl_id reale + contactId ghl_id", async () => {
    // Contatto con ghl_id reale: deve essere accettabile in input E esposto in output
    const contactGhlId = "ghlCONTACTinv00001";
    await query("UPDATE contacts SET ghl_id = $1 WHERE id = $2", [contactGhlId, contact.id]);

    const createRes = await fetch("/invoices", {
      method: "POST",
      body: JSON.stringify({
        contactId: contactGhlId,
        items: [{ description: "Riga", quantity: 1, unitPrice: 70 }],
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.invoice.contactId, contactGhlId, "contactId in output = ghl_id reale");
    const uuidId = createRes.data.invoice.id;

    const realGhlId = "ghlINVOICEparity001";
    await query("UPDATE invoices SET ghl_id = $1 WHERE external_id = $2", [realGhlId, uuidId]);

    const getRes = await fetch(`/invoices/${realGhlId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.invoice.id, realGhlId, "id risposta deve essere il ghl_id reale");
    assert.equal(getRes.data.invoice.contactId, contactGhlId);
    // Item: id esposto sempre via publicId (ghl_id se presente, altrimenti UUID)
    assert.ok(getRes.data.invoice.items[0].id);

    const putRes = await fetch(`/invoices/${realGhlId}`, {
      method: "PUT",
      body: JSON.stringify({ notes: "Rt notes" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.invoice.notes, "Rt notes");

    // Filtro per contactId col ghl_id reale del contatto
    const listRes = await fetch(`/invoices?contactId=${contactGhlId}`);
    assert.equal(listRes.status, 200);
    const found = listRes.data.invoices.filter((i) => i.id === realGhlId);
    assert.equal(found.length, 1, "la fattura deve comparire filtrando per contactId=ghl_id");

    // DELETE col ghl_id reale (draft → permesso)
    const delRes = await fetch(`/invoices/${realGhlId}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
  });

  test("Parity ghl_id: id malformato (300 char) → 400 su products e invoices", async () => {
    const bogus = "x".repeat(300);
    const p = await fetch(`/products/${bogus}`);
    assert.equal(p.status, 400);
    const i = await fetch(`/invoices/${bogus}`);
    assert.equal(i.status, 400);
    // Id ben formato ma inesistente → 404 (non più 400)
    const p404 = await fetch("/products/ghlINESISTENTE000000001");
    assert.equal(p404.status, 404);
    const i404 = await fetch("/invoices/ghlINESISTENTE00000001");
    assert.equal(i404.status, 404);
  });
});
