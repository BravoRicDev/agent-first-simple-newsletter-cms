import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "../helpers.js";
import apiCloneRoutes from "../../src/routes/api-clone/index.js";

// Parità shape di POST /contacts/search con la risposta REALE di sorgente
// (riferimento: .tmp-compare/source-real-francesco.json). Confrontiamo NOMI dei
// campi e SHAPE nidificati; i VALORI sono fake (nessuna PII reale committata).

// location_external_id ha UNIQUE globale: valore unico per-run per non collidere
// con altri siti/giri. Il test confronta il campo locationId con QUESTO valore.
const LOC = "LOC-" + crypto.randomBytes(6).toString("hex");
const SOURCE_ID = "taKYywdcxTPXTktWJi8g";

// Set ESATTO delle chiavi del contatto nella risposta reale di sorgente.
const SOURCE_CONTACT_KEYS = [
  "id", "phoneLabel", "country", "address", "source", "type", "locationId", "website",
  "dnd", "state", "businessName", "customFields", "tags", "dateAdded", "additionalEmails",
  "phone", "companyName", "additionalPhones", "dateUpdated", "city", "dateOfBirth",
  "firstNameLowerCase", "lastNameLowerCase", "firstName", "lastName", "contactName",
  "email", "assignedTo", "followers", "validEmail", "dndSettings", "opportunities",
  "postalCode", "businessId", "searchAfter", "timezone", "inboundDndSettings",
  "attributionSource", "lastAttributionSource",
].sort();

function sourceRawFixture() {
  return {
    id: SOURCE_ID, phoneLabel: null, country: "US", address: null, source: "Test Source",
    type: "lead", locationId: LOC, website: null, dnd: false, state: null, businessName: null,
    customFields: [{ id: "68Ozsrw9u5qYp0nFSyfb", value: "segreteria" }],
    tags: [], dateAdded: "2026-09-10T14:50:58.775Z", additionalEmails: [], phone: "+39000000000",
    companyName: null, additionalPhones: [], dateUpdated: "2026-09-10T15:13:59.995Z",
    city: null, dateOfBirth: null, firstNameLowerCase: "mario", lastNameLowerCase: "rossi",
    firstName: "Mario", lastName: "Rossi", contactName: "mario rossi",
    email: "mario.rossi@example.test", assignedTo: "QzzlvVmNjJM7k71wwdOA", followers: [],
    validEmail: null, dndSettings: {},
    opportunities: [{ pipelineId: "bNwd45BiBpC9WeHxXGm9", id: "hmKnC7xeURh2tPf33ZVL", monetaryValue: 2000, pipelineStageId: "98cc78d8-aee3-415b-9f9c-b26fd5392267", status: "open" }],
    postalCode: null, businessId: null, searchAfter: [1789051858775, SOURCE_ID],
    timezone: "Europe/Rome", inboundDndSettings: {},
    attributionSource: { sessionSource: "Direct traffic", medium: "form", mediumId: "MOmg82oobAtJIHLXkbMJ", userAgent: "UA", ip: "1.2.3.4", url: "https://example.test/x" },
    lastAttributionSource: { sessionSource: "Direct traffic", medium: "form", mediumId: "MOmg82oobAtJIHLXkbMJ", userAgent: "UA", ip: "1.2.3.4", url: "https://example.test/y" },
  };
}

describe("clone-API /contacts/search — shape IDENTICO a sorgente", () => {
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

  test("customFields: shape {id,value} con source_id REALE (non UUID), niente key/field_value", async () => {
    await clean();
    const email = uniqueEmail("cfparity");
    const c = (await query(
      "INSERT INTO contacts (site_id,email,source_id,created_at,updated_at) VALUES ($1,$2,$3,NOW(),NOW()) RETURNING id",
      [site.id, email, SOURCE_ID]
    )).rows[0];
    await query(
      "INSERT INTO custom_fields (site_id,object_key,field_key,name,type,active,source_id) VALUES ($1,'contact','fonte_lead','Fonte','text',true,$2)",
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
    assert.equal(cf[0].id, "sKBNK45IxxtT4sZbDkdo", "deve esporre il source_id reale del campo, non l'UUID interno");
    assert.equal(cf[0].value, "Organico");
  });

  test("contatto: set di chiavi IDENTICO a sorgente + shape nidificati corretti", async () => {
    await clean();
    const email = uniqueEmail("shape");
    await query(
      "INSERT INTO contacts (site_id,email,source_id,created_at,updated_at,source_contact_raw) VALUES ($1,$2,$3,NOW(),NOW(),$4)",
      [site.id, email, SOURCE_ID, JSON.stringify(sourceRawFixture())]
    );
    const { body } = await doSearch();
    const contact = body.contacts[0];

    assert.deepEqual(Object.keys(contact).sort(), SOURCE_CONTACT_KEYS, "stesso set di chiavi del contatto sorgente");

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

    // null dove sorgente usa null (NON stringa vuota)
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
    assert.equal(contact.id, SOURCE_ID);
    assert.equal(contact.firstNameLowerCase, "mario");
    assert.equal(contact.lastNameLowerCase, "rossi");
    assert.equal(contact.contactName, "mario rossi");
    assert.equal(contact.timezone, "Europe/Rome");
  });

  test("risposta TOP flat {contacts,total,traceId} — NESSUN wrapper meta", async () => {
    await clean();
    const email = uniqueEmail("flat");
    await query(
      "INSERT INTO contacts (site_id,email,source_id,created_at,updated_at,source_contact_raw) VALUES ($1,$2,$3,NOW(),NOW(),$4)",
      [site.id, email, SOURCE_ID, JSON.stringify(sourceRawFixture())]
    );
    const { body } = await doSearch();
    assert.ok(Array.isArray(body.contacts));
    assert.equal(typeof body.total, "number");
    assert.equal(typeof body.traceId, "string");
    assert.ok(body.traceId.length > 0);
    assert.equal("meta" in body, false, "sorgente /contacts/search non wrappa in meta");
    assert.equal("nextPage" in body, false);
    assert.equal("prevPage" in body, false);
  });

  test("GET /contacts (query string) continua a usare sendList con meta — non toccato", async () => {
    await clean();
    const email = uniqueEmail("getlist");
    await query(
      "INSERT INTO contacts (site_id,email,source_id,created_at,updated_at) VALUES ($1,$2,$3,NOW(),NOW())",
      [site.id, email, "sourceGetList1"]
    );
    const res = await fetch(`${baseUrl}/contacts?locationId=${site.id}&limit=5`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json();
    assert.ok(Array.isArray(body.contacts));
    assert.ok(body.meta && typeof body.meta.total === "number", "GET /contacts mantiene il wrapper meta");
  });

  test("page numerico (OFFSET-style, come manda davvero sorgente): pagine diverse, senza sovrapposizioni, ordine rispettato", async () => {
    await clean();
    const N = 25;
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      await query(
        "INSERT INTO contacts (site_id,email,source_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)",
        [site.id, uniqueEmail(`pagenum${i}`), `sourcePage${i}`, new Date(now - i * 60000)]
      );
    }
    const searchPage = async (page) => {
      const res = await fetch(`${baseUrl}/contacts/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: String(site.id), pageLimit: 10, page,
          sort: [{ field: "dateAdded", direction: "desc" }],
        }),
      });
      return res.json();
    };

    const p1 = await searchPage(1);
    const p2 = await searchPage(2);
    const p3 = await searchPage(3);

    assert.equal(p1.contacts.length, 10);
    assert.equal(p2.contacts.length, 10);
    assert.equal(p3.contacts.length, 5);
    assert.equal(p1.total, N);

    const ids1 = p1.contacts.map((c) => c.id);
    const ids2 = p2.contacts.map((c) => c.id);
    const ids3 = p3.contacts.map((c) => c.id);
    assert.equal(new Set([...ids1, ...ids2]).size, 20, "pagina 1 e 2 non devono sovrapporsi");
    assert.equal(new Set([...ids1, ...ids2, ...ids3]).size, N, "le 3 pagine devono coprire tutti i contatti senza duplicati");

    // dateAdded decrescente mantenuto attraverso i confini di pagina.
    const lastP1 = p1.contacts[p1.contacts.length - 1].dateAdded;
    const firstP2 = p2.contacts[0].dateAdded;
    assert.ok(lastP1 >= firstP2, "l'ordine deve restare decrescente tra fine pagina 1 e inizio pagina 2");
  });

  // body.filters (array [{field,operator,value}]) stile sorgente reale — verificato
  // dal vivo su sorgente: email:eq e phone:eq fanno match esatto, firstNameLowerCase:
  // contains fa substring case-insensitive. Il nostro endpoint lo ignorava
  // del tutto prima di questo fix.
  async function searchWithFilters(filters, extra = {}) {
    const res = await fetch(`${baseUrl}/contacts/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: String(site.id), pageLimit: 20, filters, ...extra }),
    });
    return res.json();
  }

  async function insertContact({ email, phone, firstName }) {
    const row = (await query(
      "INSERT INTO contacts (site_id,email,source_id,created_at,updated_at) VALUES ($1,$2,$3,NOW(),NOW()) RETURNING id",
      [site.id, email, crypto.randomUUID()]
    )).rows[0];
    await query(
      `INSERT INTO contact_custom_values (site_id, contact_id, object_key, values)
       VALUES ($1,$2,'contact',$3)`,
      [site.id, row.id, JSON.stringify({ phone: phone || "", firstName: firstName || "" })]
    );
    return row.id;
  }

  test("filters: email:eq restituisce SOLO il contatto con quella email esatta", async () => {
    await clean();
    await insertContact({ email: uniqueEmail("alice"), phone: "+391111111111", firstName: "Alice" });
    const target = uniqueEmail("bob-target");
    await insertContact({ email: target, phone: "+392222222222", firstName: "Bob" });

    const body = await searchWithFilters([{ field: "email", operator: "eq", value: target }]);
    assert.equal(body.total, 1);
    assert.equal(body.contacts.length, 1);
    assert.equal(body.contacts[0].email, target);
  });

  test("filters: phone:eq restituisce SOLO il contatto con quel telefono esatto", async () => {
    await clean();
    await insertContact({ email: uniqueEmail("carol"), phone: "+393333333333", firstName: "Carol" });
    await insertContact({ email: uniqueEmail("dave"), phone: "+394444444444", firstName: "Dave" });

    const body = await searchWithFilters([{ field: "phone", operator: "eq", value: "+394444444444" }]);
    assert.equal(body.total, 1);
    assert.equal(body.contacts[0].phone, "+394444444444");
  });

  test("filters: firstNameLowerCase:contains fa substring case-insensitive, più risultati", async () => {
    await clean();
    await insertContact({ email: uniqueEmail("francesco1"), phone: "+391000000001", firstName: "Francesco" });
    await insertContact({ email: uniqueEmail("francesca1"), phone: "+391000000002", firstName: "Francesca" });
    await insertContact({ email: uniqueEmail("mario1"), phone: "+391000000003", firstName: "Mario" });

    const body = await searchWithFilters([{ field: "firstNameLowerCase", operator: "contains", value: "FRANC" }]);
    assert.equal(body.total, 2, "deve trovare Francesco e Francesca, non Mario, case-insensitive");
    const names = body.contacts.map((c) => c.firstName).sort();
    assert.deepEqual(names, ["Francesca", "Francesco"]);
  });

  test("filters: combinazione field+operator NON supportata viene ignorata (nessun crash, nessun filtro applicato)", async () => {
    await clean();
    await insertContact({ email: uniqueEmail("eve"), phone: "+395555555555", firstName: "Eve" });
    await insertContact({ email: uniqueEmail("frank"), phone: "+396666666666", firstName: "Frank" });

    const body = await searchWithFilters([{ field: "firstNameLowerCase", operator: "eq", value: "Eve" }]);
    assert.equal(body.total, 2, "combinazione non in allowlist: filtro ignorato, torna tutto invariato, niente errore 500");
  });

  test("filters: indici placeholder corretti anche insieme a email/query legacy nello stesso body", async () => {
    // Regressione mirata: verifica che i $N di filters e quelli dei parametri
    // legacy (query/tag/email top-level, dialetto interno) non collidano
    // quando entrambi presenti nello stesso body — bug reale trovato in
    // revisione prima di questo commit (riordino a posteriori dell'array
    // parametri disallineato dai placeholder già scritti in whereClause).
    await clean();
    const target = uniqueEmail("combo-target");
    await insertContact({ email: target, phone: "+397777777777", firstName: "ComboTarget" });
    await insertContact({ email: uniqueEmail("combo-other"), phone: "+398888888888", firstName: "ComboOther" });

    const body = await searchWithFilters(
      [{ field: "firstNameLowerCase", operator: "contains", value: "combo" }],
      { email: target }
    );
    assert.equal(body.total, 1, "AND tra filtro contains e email legacy esatta deve isolare un solo contatto");
    assert.equal(body.contacts[0].email, target);
  });
});
