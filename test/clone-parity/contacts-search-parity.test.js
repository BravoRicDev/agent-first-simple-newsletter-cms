import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "../helpers.js";
import apiCloneRoutes from "../../src/routes/api-clone/index.js";

// Parità shape di POST /contacts/search con la risposta REALE di GHL
// (riferimento: .tmp-compare/ghl-real-francesco.json). Confrontiamo NOMI dei
// campi e SHAPE nidificati; i VALORI sono fake (nessuna PII reale committata).

// location_external_id ha UNIQUE globale: valore unico per-run per non collidere
// con altri siti/giri. Il test confronta il campo locationId con QUESTO valore.
const LOC = "LOC-" + crypto.randomBytes(6).toString("hex");
const GHL_ID = "taKYywdcxTPXTktWJi8g";

// Set ESATTO delle chiavi del contatto nella risposta reale di GHL.
const GHL_CONTACT_KEYS = [
  "id", "phoneLabel", "country", "address", "source", "type", "locationId", "website",
  "dnd", "state", "businessName", "customFields", "tags", "dateAdded", "additionalEmails",
  "phone", "companyName", "additionalPhones", "dateUpdated", "city", "dateOfBirth",
  "firstNameLowerCase", "lastNameLowerCase", "firstName", "lastName", "contactName",
  "email", "assignedTo", "followers", "validEmail", "dndSettings", "opportunities",
  "postalCode", "businessId", "searchAfter", "timezone", "inboundDndSettings",
  "attributionSource", "lastAttributionSource",
].sort();

function ghlRawFixture() {
  return {
    id: GHL_ID, phoneLabel: null, country: "US", address: null, source: "Test Source",
    type: "lead", locationId: LOC, website: null, dnd: false, state: null, businessName: null,
    customFields: [{ id: "68Ozsrw9u5qYp0nFSyfb", value: "segreteria" }],
    tags: [], dateAdded: "2026-09-10T14:50:58.775Z", additionalEmails: [], phone: "+39000000000",
    companyName: null, additionalPhones: [], dateUpdated: "2026-09-10T15:13:59.995Z",
    city: null, dateOfBirth: null, firstNameLowerCase: "mario", lastNameLowerCase: "rossi",
    firstName: "Mario", lastName: "Rossi", contactName: "mario rossi",
    email: "mario.rossi@example.test", assignedTo: "QzzlvVmNjJM7k71wwdOA", followers: [],
    validEmail: null, dndSettings: {},
    opportunities: [{ pipelineId: "bNwd45BiBpC9WeHxXGm9", id: "hmKnC7xeURh2tPf33ZVL", monetaryValue: 2000, pipelineStageId: "98cc78d8-aee3-415b-9f9c-b26fd5392267", status: "open" }],
    postalCode: null, businessId: null, searchAfter: [1789051858775, GHL_ID],
    timezone: "Europe/Rome", inboundDndSettings: {},
    attributionSource: { sessionSource: "Direct traffic", medium: "form", mediumId: "MOmg82oobAtJIHLXkbMJ", userAgent: "UA", ip: "1.2.3.4", url: "https://example.test/x" },
    lastAttributionSource: { sessionSource: "Direct traffic", medium: "form", mediumId: "MOmg82oobAtJIHLXkbMJ", userAgent: "UA", ip: "1.2.3.4", url: "https://example.test/y" },
  };
}

describe("clone-API /contacts/search — shape IDENTICO a GHL", () => {
  let server, baseUrl, site, apiKey;

  before(async () => {
    site = await createTestSite("Search Parity");
    await query("UPDATE sites SET location_external_id = $1 WHERE id = $2", [LOC, site.id]);
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1,$2,$3,$4,true)",
      [site.id, "k", hash, raw.slice(0, 12)]
    );
    apiKey = raw;
    const app = express();
    app.use(express.json());
    app.use(apiCloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "nf" }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ statusCode: err.status || 500, message: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    await query("DELETE FROM contacts WHERE site_id=$1", [site.id]);
    await query("DELETE FROM custom_fields WHERE site_id=$1", [site.id]);
    await query("DELETE FROM contact_custom_values WHERE site_id=$1", [site.id]);
    await query("DELETE FROM site_api_keys WHERE site_id=$1", [site.id]);
    await query("DELETE FROM sites WHERE id=$1", [site.id]);
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const clean = async () => {
    await query("DELETE FROM contacts WHERE site_id=$1", [site.id]);
    await query("DELETE FROM custom_fields WHERE site_id=$1", [site.id]);
    await query("DELETE FROM contact_custom_values WHERE site_id=$1", [site.id]);
  };

  async function doSearch() {
    const res = await fetch(`${baseUrl}/contacts/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: String(site.id), pageLimit: 20 }),
    });
    return { status: res.status, body: await res.json() };
  }

  test("customFields: shape {id,value} con ghl_id REALE (non UUID), niente key/field_value", async () => {
    await clean();
    const email = uniqueEmail("cfparity");
    const c = (await query(
      "INSERT INTO contacts (site_id,email,ghl_id,created_at,updated_at) VALUES ($1,$2,$3,NOW(),NOW()) RETURNING id",
      [site.id, email, GHL_ID]
    )).rows[0];
    await query(
      "INSERT INTO custom_fields (site_id,object_key,field_key,name,type,active,ghl_id) VALUES ($1,'contact','fonte_lead','Fonte','text',true,$2)",
      [site.id, "sKBNK45IxxtT4sZbDkdo"]
    );
    await query(
      "INSERT INTO contact_custom_values (site_id,contact_id,object_key,values) VALUES ($1,$2,'contact',$3)",
      [site.id, c.id, JSON.stringify({ firstName: "Mario", lastName: "Rossi", fonte_lead: "Organico" })]
    );
    const { body } = await doSearch();
    const cf = body.contacts[0].customFields;
    assert.equal(cf.length, 1, "il campo di profilo (firstName/lastName) NON deve comparire come customField");
    assert.deepEqual(Object.keys(cf[0]).sort(), ["id", "value"], "solo {id, value}: niente key/field_value");
    assert.equal(cf[0].id, "sKBNK45IxxtT4sZbDkdo", "deve esporre il ghl_id reale del campo, non l'UUID interno");
    assert.equal(cf[0].value, "Organico");
  });

  test("contatto: set di chiavi IDENTICO a GHL + shape nidificati corretti", async () => {
    await clean();
    const email = uniqueEmail("shape");
    await query(
      "INSERT INTO contacts (site_id,email,ghl_id,created_at,updated_at,ghl_contact_raw) VALUES ($1,$2,$3,NOW(),NOW(),$4)",
      [site.id, email, GHL_ID, JSON.stringify(ghlRawFixture())]
    );
    const { body } = await doSearch();
    const contact = body.contacts[0];

    assert.deepEqual(Object.keys(contact).sort(), GHL_CONTACT_KEYS, "stesso set di chiavi del contatto GHL");

    // customFields: array (qui vuoto, nessun def)
    assert.ok(Array.isArray(contact.customFields));

    // opportunities embedded (dal raw, nessuna chiamata extra)
    assert.ok(Array.isArray(contact.opportunities) && contact.opportunities.length === 1);
    assert.deepEqual(
      Object.keys(contact.opportunities[0]).sort(),
      ["id", "monetaryValue", "pipelineId", "pipelineStageId", "status"]
    );
    assert.equal(contact.opportunities[0].pipelineId, "bNwd45BiBpC9WeHxXGm9");
    assert.equal(contact.opportunities[0].monetaryValue, 2000);

    // attributionSource / lastAttributionSource: oggetti con le chiavi giuste
    assert.deepEqual(
      Object.keys(contact.attributionSource).sort(),
      ["ip", "medium", "mediumId", "sessionSource", "url", "userAgent"]
    );
    assert.ok(contact.lastAttributionSource && typeof contact.lastAttributionSource === "object");

    // searchAfter: [timestamp_ms, id]
    assert.ok(Array.isArray(contact.searchAfter) && contact.searchAfter.length === 2);
    assert.equal(typeof contact.searchAfter[0], "number");
    assert.equal(typeof contact.searchAfter[1], "string");

    // oggetti/array di default
    assert.deepEqual(contact.dndSettings, {});
    assert.deepEqual(contact.inboundDndSettings, {});
    assert.deepEqual(contact.additionalEmails, []);
    assert.deepEqual(contact.additionalPhones, []);
    assert.deepEqual(contact.followers, []);
    assert.deepEqual(contact.tags, []);

    // null dove GHL usa null (NON stringa vuota)
    assert.equal(contact.companyName, null);
    assert.equal(contact.website, null);
    assert.equal(contact.validEmail, null);
    assert.equal(contact.businessId, null);
    assert.equal(contact.phoneLabel, null);
    assert.equal(contact.dateOfBirth, null);
    assert.equal(contact.address, null);
    assert.equal(contact.state, null);
    assert.equal(contact.city, null);
    assert.equal(contact.postalCode, null);
    assert.equal(contact.businessName, null);

    // campi presenti dal raw
    assert.equal(contact.source, "Test Source");
    assert.equal(contact.type, "lead");
    assert.equal(contact.dnd, false);
    assert.equal(contact.assignedTo, "QzzlvVmNjJM7k71wwdOA");
    assert.equal(contact.locationId, LOC);
    assert.equal(contact.id, GHL_ID);
    assert.equal(contact.firstNameLowerCase, "mario");
    assert.equal(contact.lastNameLowerCase, "rossi");
    assert.equal(contact.contactName, "mario rossi");
    assert.equal(contact.timezone, "Europe/Rome");
  });

  test("risposta TOP flat {contacts,total,traceId} — NESSUN wrapper meta", async () => {
    await clean();
    const email = uniqueEmail("flat");
    await query(
      "INSERT INTO contacts (site_id,email,ghl_id,created_at,updated_at,ghl_contact_raw) VALUES ($1,$2,$3,NOW(),NOW(),$4)",
      [site.id, email, GHL_ID, JSON.stringify(ghlRawFixture())]
    );
    const { body } = await doSearch();
    assert.ok(Array.isArray(body.contacts));
    assert.equal(typeof body.total, "number");
    assert.equal(typeof body.traceId, "string");
    assert.ok(body.traceId.length > 0);
    assert.equal("meta" in body, false, "GHL /contacts/search non wrappa in meta");
    assert.equal("nextPage" in body, false);
    assert.equal("prevPage" in body, false);
  });

  test("GET /contacts (query string) continua a usare sendList con meta — non toccato", async () => {
    await clean();
    const email = uniqueEmail("getlist");
    await query(
      "INSERT INTO contacts (site_id,email,ghl_id,created_at,updated_at) VALUES ($1,$2,$3,NOW(),NOW())",
      [site.id, email, "ghlGetList1"]
    );
    const res = await fetch(`${baseUrl}/contacts?locationId=${site.id}&limit=5`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json();
    assert.ok(Array.isArray(body.contacts));
    assert.ok(body.meta && typeof body.meta.total === "number", "GET /contacts mantiene il wrapper meta");
  });
});
