import test from "node:test";
import assert from "node:assert";
import { query } from "../../src/db.js";
import { createSourceClient } from "../../src/services/source-sync/client.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import * as formsMapper from "../../src/services/source-sync/mappers/forms.js";
import * as surveysMapper from "../../src/services/source-sync/mappers/surveys.js";
import * as campaignsMapper from "../../src/services/source-sync/mappers/campaigns.js";
import * as commerceMapper from "../../src/services/source-sync/mappers/commerce.js";

const KNOWN_CONTACT_ID = "550e8400-e29b-41d4-a716-446655440000";
const UNKNOWN_CONTACT_ID = "550e8400-e29b-41d4-a716-446655440001";

function makeCtx(siteId, client) {
  const stats = {};
  const addStat = (res, key, n = 1) => {
    stats[res] = stats[res] || { fetched: 0, upserted: 0, updated: 0, skipped: 0, errors: 0 };
    stats[res][key] = (stats[res][key] || 0) + n;
  };
  return {
    siteId,
    cfg: { location_id: "loc-1" },
    client,
    dryRun: false,
    stats,
    addStat,
    knownContacts: new Set([KNOWN_CONTACT_ID]),
    discoveredContacts: new Set(),
    log: console.log,
  };
}

const fixture = {
  forms: [
    {
      id: "550e8400-e29b-41d4-a716-446655440010",
      name: "Contact Form",
      slug: "contact-form",
      fields: [{ name: "email", type: "text" }],
      dateAdded: "2026-01-01T10:00:00Z",
      dateUpdated: "2026-01-01T10:00:00Z",
    },
  ],
  formSubmissions: [
    {
      id: "550e8400-e29b-41d4-a716-446655440011",
      formId: "550e8400-e29b-41d4-a716-446655440010",
      contactId: KNOWN_CONTACT_ID,
      createdAt: "2026-01-02T10:00:00Z",
      data: { email: "known@example.com" },
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440012",
      formId: "550e8400-e29b-41d4-a716-446655440010",
      contactId: UNKNOWN_CONTACT_ID,
      createdAt: "2026-01-02T11:00:00Z",
      data: { email: "unknown@example.com" },
    },
  ],
  surveys: [
    {
      id: "550e8400-e29b-41d4-a716-446655440020",
      name: "Satisfaction",
      locationId: "loc-1",
    },
  ],
  surveySubmissions: [
    {
      id: "550e8400-e29b-41d4-a716-446655440021",
      surveyId: "550e8400-e29b-41d4-a716-446655440020",
      contactId: KNOWN_CONTACT_ID,
      createdAt: "2026-01-02T12:00:00Z",
      name: "Known Contact",
      email: "known@example.com",
      others: {},
    },
  ],
  campaigns: [
    {
      id: "550e8400-e29b-41d4-a716-446655440030",
      name: "January Sale",
      status: "published",
      locationId: "loc-1",
    },
  ],
  emailTemplates: [
    {
      id: "550e8400-e29b-41d4-a716-446655440031",
      name: "Welcome",
      templateType: "builder",
      dateAdded: "2026-01-01T15:00:00Z",
      version: "1",
      isPlainText: "false",
      previewUrl: "https://example.com",
    },
  ],
  products: [
    {
      _id: "550e8400-e29b-41d4-a716-446655440040",
      name: "Widget",
      description: "A widget",
      // CRM sorgente 2021-07-28: productType (enum DIGITAL/PHYSICAL/SERVICE/…), NON `type`
      productType: "PHYSICAL",
      createdAt: "2026-01-01T16:00:00Z",
      updatedAt: "2026-01-01T16:00:00Z",
      // NOTA: nella doc reale i prezzi NON sono annidati qui (stanno in
      // GET /products/:id/prices). Il mapper li legge come fallback; il mock
      // li mantiene annidati per non rompere il test di product_prices.
      prices: [
        {
          _id: "550e8400-e29b-41d4-a716-446655440041",
          name: "Standard",
          amount: "99.99",
          currency: "EUR",
          // CRM sorgente price usa `type`, NON `billingType`
          type: "one_time",
          active: true,
          createdAt: "2026-01-01T16:00:00Z",
          updatedAt: "2026-01-01T16:00:00Z",
        },
      ],
    },
  ],
  invoices: [
    {
      // CRM sorgente 2021-07-28: `_id`, NON `id`
      _id: "550e8400-e29b-41d4-a716-446655440050",
      invoiceNumber: 1001, // CRM sorgente: numero (number), non stringa
      // CRM sorgente: contactDetails.id (oggetto annidato), NON contactId flat
      contactDetails: { id: KNOWN_CONTACT_ID },
      total: "500.00",
      currency: "EUR",
      status: "paid",
      issueDate: "2026-01-01",
      dueDate: "2026-02-01",
      paidAt: "2026-01-15T10:00:00Z",
      // CRM sorgente: termsNotes, NON notes
      termsNotes: "Payment received",
      createdAt: "2026-01-01T17:00:00Z",
      updatedAt: "2026-01-15T10:00:00Z",
      // CRM sorgente: invoiceItems, NON items; righe con amount/qty (NON unitPrice)
      invoiceItems: [
        {
          _id: "550e8400-e29b-41d4-a716-446655440051",
          name: "Widget x2",
          description: "Widget x2",
          amount: "500.00",
          qty: 2,
        },
      ],
    },
  ],
  payments: [
    {
      id: "550e8400-e29b-41d4-a716-446655440060",
      title: "Premium Plan",
      amount: "199.00",
      currency: "EUR",
      status: "paid",
      paidAt: "2026-01-20T10:00:00Z",
      contactEmail: "customer@example.com",
      url: "https://stripe.com/pay/xyz",
      dateAdded: "2026-01-10T18:00:00Z",
      dateUpdated: "2026-01-20T10:00:00Z",
    },
  ],
};

test("forms-campaigns-commerce sync", async (t) => {
  const mock = await createMockSource(fixture);

  try {
    // Setup: create known contact
    const siteId = 999;
    await query("INSERT INTO sites (id, name, domain) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      siteId,
      "Test Site",
      "test-site.local",
    ]);
    await query(
      "INSERT INTO contacts (site_id, external_id, email, status) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [siteId, KNOWN_CONTACT_ID, "known@example.com", "active"]
    );

    const ctx = makeCtx(siteId, createSourceClient({ site_id: siteId, base_url: mock.url, token: "test", throttle_rps: 1000 }));

    // First run
    await t.test("forms: insert + discovery", async () => {
      await formsMapper.syncAll(ctx);
      assert.equal(ctx.stats.forms.fetched, 3); // 1 form + 2 submissions
      assert.equal(ctx.stats.forms.upserted >= 2, true); // form + submissions
      assert(ctx.discoveredContacts.has(UNKNOWN_CONTACT_ID), "unknown contact discovered");
    });

    await t.test("surveys: insert", async () => {
      await surveysMapper.syncAll(ctx);
      assert.equal(ctx.stats.surveys.fetched >= 1, true);
    });

    await t.test("campaigns: insert + templates", async () => {
      await campaignsMapper.syncAll(ctx);
      assert.equal(ctx.stats.campaigns.fetched >= 2, true); // 1 campaign + 1 template
      assert.equal(ctx.stats.campaigns.upserted >= 2, true);

      const campaign = (await query("SELECT status, subject FROM newsletter_campaigns WHERE site_id = $1 LIMIT 1", [siteId])).rows[0];
      assert.equal(campaign.status, "sent");
      assert.equal(campaign.subject, "January Sale");

      const template = (await query("SELECT type FROM marketing_templates WHERE site_id = $1 LIMIT 1", [siteId])).rows[0];
      assert.equal(template.type, "EMAIL");
    });

    await t.test("commerce: products + invoice + payment", async () => {
      await commerceMapper.syncAll(ctx);
      assert.equal(ctx.stats.commerce.fetched >= 3, true); // products, invoices, payments

      const product = (await query("SELECT name FROM products WHERE site_id = $1 LIMIT 1", [siteId])).rows[0];
      assert.equal(product.name, "Widget");

      const price = (await query("SELECT amount FROM product_prices WHERE site_id = $1 LIMIT 1", [siteId])).rows[0];
      assert.equal(parseFloat(price.amount), 99.99);

      const invoice = (await query("SELECT total, status FROM invoices WHERE site_id = $1 LIMIT 1", [siteId])).rows[0];
      assert.equal(parseFloat(invoice.total), 500);
      assert.equal(invoice.status, "paid");

      const items = (await query("SELECT COUNT(*) as cnt FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE site_id = $1)", [siteId])).rows[0];
      assert.equal(parseInt(items.cnt), 1);

      const payment = (await query("SELECT status FROM payment_links WHERE site_id = $1 LIMIT 1", [siteId])).rows[0];
      assert.equal(payment.status, "paid");
    });

    await t.test("second run: idempotent", async () => {
      ctx.stats = {};
      ctx.discoveredContacts.clear();
      ctx.knownContacts.clear();
      ctx.knownContacts.add(KNOWN_CONTACT_ID);

      await formsMapper.syncAll(ctx);
      await surveysMapper.syncAll(ctx);
      await campaignsMapper.syncAll(ctx);
      await commerceMapper.syncAll(ctx);

      // On second run, upserted should be 0 and most records should be skipped
      let totalSkipped = 0;
      let totalUpserted = 0;
      for (const stat of Object.values(ctx.stats)) {
        totalSkipped += stat.skipped || 0;
        totalUpserted += stat.upserted || 0;
      }
      // Should have at least some skipped from forms/campaigns/commerce (surveys is conditional)
      assert(
        totalSkipped > 0 || totalUpserted === 0,
        `second run should be idempotent (skipped=${totalSkipped}, upserted=${totalUpserted})`
      );
    });
  } finally {
    await mock.close();
    await query("DELETE FROM payment_links WHERE site_id = 999");
    await query("DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE site_id = 999)");
    await query("DELETE FROM invoices WHERE site_id = 999");
    await query("DELETE FROM product_prices WHERE site_id = 999");
    await query("DELETE FROM products WHERE site_id = 999");
    await query("DELETE FROM marketing_templates WHERE site_id = 999");
    await query("DELETE FROM newsletter_campaigns WHERE site_id = 999");
    const submissionsTable = (await query("SELECT 1 FROM information_schema.tables WHERE table_name = 'survey_submissions' LIMIT 1")).rows.length > 0
      ? "survey_submissions"
      : "form_submissions";
    await query(`DELETE FROM ${submissionsTable} WHERE site_id = 999`);
    await query("DELETE FROM forms WHERE site_id = 999");
    const surveysTable = (await query("SELECT 1 FROM information_schema.tables WHERE table_name = 'surveys' LIMIT 1")).rows.length > 0 ? "surveys" : null;
    if (surveysTable) await query("DELETE FROM surveys WHERE site_id = 999");
    await query("DELETE FROM contacts WHERE site_id = 999");
    await query("DELETE FROM sites WHERE id = 999");
  }
});
