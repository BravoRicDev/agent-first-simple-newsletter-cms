import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { encryptSecret } from "../../src/services/crypto.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import { recordComparison, compareGhlSubset } from "../../src/services/ghl-parity.js";
import { getContact, getContactTasks, searchContacts } from "../../src/services/contacts-clone.js";
import * as tagsService from "../../src/services/tags.js";
import * as opportunitiesClone from "../../src/services/opportunities-clone.js";
import * as calendarsClone from "../../src/services/calendars-clone.js";
import * as campaignsClone from "../../src/services/campaigns-clone.js";
import * as productsClone from "../../src/services/products-clone.js";
import * as invoicesClone from "../../src/services/invoices-clone.js";

// Verifica che il collegamento reale della shadow-comparison (ghl-parity.js)
// raggiunga TUTTI gli endpoint estesi in questo round (oltre a note/custom-fields,
// già coperti da ghl-parity-wiring.test.js) — un test per endpoint, riproducendo
// ESATTAMENTE la stessa sequenza fatta dalla rotta (stesso servizio locale per
// costruire clonePayload, stesso identico fetchReal). Per le rotte non lo
// possiamo chiamare via HTTP qui (le funzioni schedule sono chiuse dentro il
// file di rotta, non esportate): replichiamo la chiamata, come già fa
// ghl-parity-wiring.test.js per l'endpoint custom-fields.
//
// getContact/getContactTasks invece SONO chiamate dirette (schedulano la
// verifica internamente), test di integrazione reale end-to-end.

function waitForBackground(ms = 150) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setupConfig(siteId, mockUrl, locationId) {
  await query(
    `INSERT INTO source_sync_config (site_id, enabled, base_url, location_id, token_enc, throttle_rps, daily_quota, budget_percent, shadow_daily_quota)
     VALUES ($1, true, $2, $3, $4, 100, 250000, 100, 1000)
     ON CONFLICT (site_id) DO UPDATE SET
       enabled = true, base_url = EXCLUDED.base_url, location_id = EXCLUDED.location_id, token_enc = EXCLUDED.token_enc`,
    [siteId, mockUrl, locationId, encryptSecret("test-token")]
  );
}

async function lastLog(siteId, endpoint) {
  return (await query(
    "SELECT * FROM ghl_parity_log WHERE site_id = $1 AND endpoint = $2 ORDER BY id DESC LIMIT 1",
    [siteId, endpoint]
  )).rows[0];
}

describe("ghl-parity — collegamento esteso a tutti gli endpoint GHL-backed", () => {
  let site, mock;

  before(async () => {
    site = await createTestSite("GHL Parity Extended Wiring Test");
    mock = await createMockSource({
      contacts: [
        { id: "src-ext-contact-001", email: "ext-parity@example.test", tags: ["vip"], notes: [], tasks: [{ id: "task-ext-1", title: "Chiama cliente", contactEmail: "ext-parity@example.test" }] },
      ],
      tags: [{ id: "src-ext-tag-001", name: "VIP" }],
      pipelines: [{ id: "src-ext-pipe-001", name: "Vendite", stages: [] }],
      workflows: [{ id: "src-ext-wf-001", name: "Follow up", status: "published" }],
      funnels: [{ _id: "src-ext-funnel-001", name: "Landing A", steps: [] }],
      calendars: [{ id: "src-ext-cal-001", name: "Consulenze", description: "" }],
      campaigns: [{ id: "src-ext-camp-001", name: "Newsletter Settembre", status: "sent" }],
      emailTemplates: [{ id: "src-ext-tpl-001", name: "Template base" }],
      products: [{ _id: "src-ext-prod-001", name: "Corso online" }],
      invoices: [{ _id: "src-ext-inv-001", invoiceNumber: "INV-001" }],
    });
    await setupConfig(site.id, mock.url, "loc-parity-ext-test");

    await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, created_at, updated_at)
       VALUES ($1, 'src-ext-contact-001', 'ext-parity@example.test', '{vip}', 'active', '', NOW(), NOW())`,
      [site.id]
    );
    await query(`INSERT INTO tasks (site_id, source_id, email, title, notes, status, created_at) VALUES ($1, 'task-ext-1', 'ext-parity@example.test', 'Chiama cliente', '', 'open', NOW())`, [site.id]);
    await query(`INSERT INTO tags (site_id, source_id, name) VALUES ($1, 'src-ext-tag-001', 'VIP')`, [site.id]);
    await query(`INSERT INTO pipelines (site_id, source_id, name, stages) VALUES ($1, 'src-ext-pipe-001', 'Vendite', '[]')`, [site.id]);
    await query(`INSERT INTO source_workflows (site_id, source_id, name, status, payload) VALUES ($1, 'src-ext-wf-001', 'Follow up', 'published', '{"id":"src-ext-wf-001","name":"Follow up","status":"published"}')`, [site.id]);
    await query(`INSERT INTO source_funnels (site_id, source_id, name, steps) VALUES ($1, 'src-ext-funnel-001', 'Landing A', '[]')`, [site.id]);
    await query(`INSERT INTO calendars (site_id, source_id, slug, name, description, enabled) VALUES ($1, 'src-ext-cal-001', 'consulenze-ext', 'Consulenze', '', true)`, [site.id]);
    await query(`INSERT INTO newsletter_campaigns (site_id, source_id, subject, html_content, status, created_at) VALUES ($1, 'src-ext-camp-001', 'Newsletter Settembre', '', 'sent', NOW())`, [site.id]);
    await query(`INSERT INTO marketing_templates (site_id, source_id, type, name, subject, body_html) VALUES ($1, 'src-ext-tpl-001', 'EMAIL', 'Template base', '', '')`, [site.id]);
    await query(`INSERT INTO products (site_id, source_id, name, description, product_type, active) VALUES ($1, 'src-ext-prod-001', 'Corso online', '', 'digital', true)`, [site.id]);
    await query(`INSERT INTO invoices (site_id, source_id, invoice_number, status, currency, total) VALUES ($1, 'src-ext-inv-001', 'INV-001', 'draft', 'EUR', 0)`, [site.id]);
  });

  after(async () => {
    await mock.close();
    await query("DELETE FROM ghl_parity_log WHERE site_id = $1", [site.id]);
    await query("DELETE FROM ghl_parity_state WHERE site_id = $1", [site.id]);
    for (const t of ["tasks", "contact_notes", "contacts", "tags", "pipeline_stages", "pipelines", "source_workflows", "source_funnels", "calendars", "newsletter_campaigns", "marketing_templates", "products", "invoices", "source_sync_config"]) {
      await query(`DELETE FROM ${t} WHERE site_id = $1`, [site.id]).catch(() => {});
    }
    await closeDb();
  });

  test("GET /contacts/:id — getContact logga match=true", async () => {
    await getContact(site.id, "src-ext-contact-001");
    await waitForBackground();
    const log = await lastLog(site.id, "GET /contacts/:id");
    assert.ok(log, "getContact deve aver generato un confronto");
    assert.equal(log.match, true);
  });

  test("GET /contacts/:id/tasks — getContactTasks logga match=true", async () => {
    await getContactTasks(site.id, "src-ext-contact-001");
    await waitForBackground();
    const log = await lastLog(site.id, "GET /contacts/:id/tasks");
    assert.ok(log, "getContactTasks deve aver generato un confronto");
    assert.equal(log.match, true);
  });

  test("GET /tags — replica wiring rotta, match=true", async () => {
    const { rows } = await tagsService.listTags(site.id, { limit: 20, startAfterId: null });
    const serialized = rows.map((r) => ({ id: r.source_id || r.external_id, name: r.name }));
    await recordComparison({
      siteId: site.id, endpoint: "GET /tags", clonePayload: serialized,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.tags || p || [] }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get(`/locations/${cfg.location_id}/tags`, {}, { sendLocationId: false });
      },
    });
    const log = await lastLog(site.id, "GET /tags");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /pipelines — replica wiring rotta, match=true", async () => {
    const pipelines = await opportunitiesClone.listPipelines(site.id, "loc-parity-ext-test");
    await recordComparison({
      siteId: site.id, endpoint: "GET /pipelines", clonePayload: pipelines,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.pipelines || p || [] }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/opportunities/pipelines");
      },
    });
    const log = await lastLog(site.id, "GET /pipelines");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /workflows — replica wiring rotta, match=true", async () => {
    const rows = (await query("SELECT payload FROM source_workflows WHERE site_id = $1", [site.id])).rows;
    const serialized = rows.map((r) => r.payload);
    await recordComparison({
      siteId: site.id, endpoint: "GET /workflows", clonePayload: serialized,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.workflows || p || [] }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/workflows/", { locationId: cfg.location_id });
      },
    });
    const log = await lastLog(site.id, "GET /workflows");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /funnels — replica wiring rotta, match=true (id GHL = _id)", async () => {
    const rows = (await query("SELECT source_id, name, steps FROM source_funnels WHERE site_id = $1", [site.id])).rows;
    const serialized = rows.map((r) => ({ id: r.source_id, name: r.name, steps: r.steps }));
    await recordComparison({
      siteId: site.id, endpoint: "GET /funnels", clonePayload: serialized,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.funnels || p || [] }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/funnels/funnel/list", { locationId: cfg.location_id });
      },
    });
    const log = await lastLog(site.id, "GET /funnels");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /calendars — replica wiring rotta, match=true", async () => {
    const result = await calendarsClone.listCalendars(site.id, { limit: 20, startAfterId: null }, "loc-parity-ext-test");
    await recordComparison({
      siteId: site.id, endpoint: "GET /calendars", clonePayload: result.calendars,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.calendars || p || [] }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/calendars/", { locationId: cfg.location_id });
      },
    });
    const log = await lastLog(site.id, "GET /calendars");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /campaigns — replica wiring rotta, match=true", async () => {
    const result = await campaignsClone.listCampaigns(site.id, { limit: 20, startAfterId: null }, "loc-parity-ext-test");
    await recordComparison({
      siteId: site.id, endpoint: "GET /campaigns", clonePayload: result.campaigns,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.campaigns || p || [] }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/campaigns/", { locationId: cfg.location_id });
      },
    });
    const log = await lastLog(site.id, "GET /campaigns");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /templates — replica wiring rotta, match=true", async () => {
    const result = await campaignsClone.listTemplates(site.id, { type: null, limit: 20, startAfterId: null }, "loc-parity-ext-test");
    await recordComparison({
      siteId: site.id, endpoint: "GET /templates", clonePayload: result.templates,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => (Array.isArray(p) ? p : p?.templates || p?.emails || []) }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/emails/builder", { locationId: cfg.location_id });
      },
    });
    const log = await lastLog(site.id, "GET /templates");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /products — replica wiring rotta, match=true (id GHL = _id)", async () => {
    const result = await productsClone.listProducts(site.id, { limit: 20, startAfterId: null }, "loc-parity-ext-test");
    await recordComparison({
      siteId: site.id, endpoint: "GET /products", clonePayload: result.products,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => (Array.isArray(p) ? p : p?.products || []) }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/products/", { locationId: cfg.location_id });
      },
    });
    const log = await lastLog(site.id, "GET /products");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  test("GET /invoices — replica wiring rotta, match=true (id GHL = _id)", async () => {
    const result = await invoicesClone.listInvoices(site.id, { limit: 20, startAfterId: null }, "loc-parity-ext-test");
    await recordComparison({
      siteId: site.id, endpoint: "GET /invoices", clonePayload: result.invoices,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => (Array.isArray(p) ? p : p?.invoices || []) }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get("/invoices/", { altId: cfg.location_id, altType: "location", limit: "100", offset: "0" });
      },
    });
    const log = await lastLog(site.id, "GET /invoices");
    assert.ok(log);
    assert.equal(log.match, true);
  });

  // POST /contacts/search — endpoint segnalato dall'utente come già in
  // produzione (apicrm.lumonboy.com/contacts/search), sfuggito alla prima
  // scansione perché la ricerca sui path GET-only aveva saltato le rotte
  // POST. È la STESSA identica chiamata (path, body, sort) già usata dal
  // sync periodico (mappers/contacts.js: paginateSearchSorted), quindi
  // confrontabile 1:1 — a differenza di GET /contacts (paginazione/filtri
  // locali arbitrari, per questo lasciato fuori).
  test("POST /contacts/search — replica wiring rotta (forma sync-equivalente: nessun filtro, sort dateUpdated desc), match=true", async () => {
    const { contacts } = await searchContacts(site.id, {
      limit: 20,
      sort: [{ field: "dateUpdated", direction: "desc" }],
    });
    await recordComparison({
      siteId: site.id, endpoint: "POST /contacts/search", clonePayload: contacts,
      isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.contacts || p || [] }),
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.raw("/contacts/search", {
          method: "POST",
          body: { locationId: cfg.location_id, pageLimit: 20, sort: [{ field: "dateUpdated", direction: "desc" }] },
          sendLocationId: false,
        });
      },
    });
    const log = await lastLog(site.id, "POST /contacts/search");
    assert.ok(log);
    assert.equal(log.match, true);
  });
});
