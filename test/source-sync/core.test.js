import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import { createSourceClient } from "../../src/services/source-sync/client.js";
import * as usersMapper from "../../src/services/source-sync/mappers/users.js";
import * as customFieldsMapper from "../../src/services/source-sync/mappers/custom-fields.js";
import * as tagsMapper from "../../src/services/source-sync/mappers/tags.js";
import * as pipelinesMapper from "../../src/services/source-sync/mappers/pipelines.js";
import * as contactsMapper from "../../src/services/source-sync/mappers/contacts.js";

// Source-sync core: users/custom-fields/tags/pipelines/contacts(+note+task).
// Verifica external_id = id sorgente, timestamp forzati e idempotenza S4.
const uuid = (n = 0) => crypto.randomUUID();

function buildFixture() {
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 86400000).toISOString();
  // users.email ha vincolo UNIQUE GLOBALE: suffisso per-run per isolare i test
  const esuf = `${crypto.randomBytes(3).toString("hex")}`;
  const em = (local) => `${local}-${esuf}@example.test`;
  const u1 = uuid(), u2 = uuid(), cf1 = uuid(), cf2 = uuid(), cf3 = uuid();
  const t1 = uuid(), t2 = uuid(), t3 = uuid();
  const p1 = uuid(), st1 = uuid(), st2 = uuid();
  const c1 = uuid(), c2 = uuid(), n1 = uuid(), k1 = uuid();
  const emails = {
    alice: em("alice"),
    bob: em("bob"),
    john: em("john"),
    jane: em("jane"),
  };
  return {
    ids: { u1, u2, cf1, cf2, cf3, t1, t2, t3, p1, st1, st2, c1, c2, n1, k1 },
    emails,
    users: [
      // Shape reale doc CRM sorgente 2021-07-28 (Get User): roles è un OGGETTO
      // { type, role, locationIds }, non un array — e non esiste alcun
      // dateAdded/dateUpdated sull'utente.
      { id: u1, email: em("alice"), name: "Alice", roles: { type: "account", role: "admin", locationIds: ["loc-test"] } },
      { id: u2, email: em("bob"), name: "Bob", roles: { type: "account", role: "user", locationIds: ["loc-test"] } },
    ],
    // Shape reale verificata dal vivo (GET /locations/{locationId}/
    // customFields, 2026-08-26): name (non label), fieldKey prefissato col
    // model (non key nudo), niente dateUpdated. "model" è aggiunto dal mock.
    customFieldsContact: [
      { id: cf1, fieldKey: "contact.citta", name: "Città", dataType: "TEXT", dateAdded: earlier },
      { id: cf2, fieldKey: "contact.budget", name: "Budget", dataType: "NUMERIC", dateAdded: earlier },
    ],
    customFieldsOpportunity: [
      { id: cf3, fieldKey: "opportunity.origine", name: "Origine", dataType: "TEXT", dateAdded: earlier },
    ],
    // NOTA: la doc CRM sorgente 2021-07-28 (Get Tags) restituisce SOLO { id, name,
    // locationId } — NESSUN color/dateAdded/dateUpdated. I campi extra qui
    // sono mantenuti solo per esercitare il percorso di skip idempotente (S4)
    // in syncAll quando il sorgente li restituisce; in produzione saranno
    // assenti e i tag verranno ri-toccati a ogni sync (lo skip S4 è
    // inoperante per i tag). Vedere bugfix-reports/tags-sync-parity.md.
    tags: [
      { id: t1, name: "prospect", color: "#ff0000", dateAdded: earlier, dateUpdated: earlier },
      { id: t2, name: "vip", dateAdded: earlier, dateUpdated: earlier },
      { id: t3, name: "Archived", dateAdded: earlier, dateUpdated: earlier },
    ],
    pipelines: [
      {
        id: p1, name: "Ventas", dateAdded: earlier, dateUpdated: earlier,
        stages: [
          { id: st1, label: "Nuovo", dateAdded: earlier, dateUpdated: earlier },
          { id: st2, label: "Offerta", dateAdded: earlier, dateUpdated: earlier },
        ],
      },
    ],
    contacts: [
      {
        id: c1, email: em("john"), firstName: "John", lastName: "Doe",
        companyName: "ACME", phone: "+393001112222", website: "",
        tags: ["prospect"], status: "", dateAdded: earlier, dateUpdated: now,
        // Shape reale verificata dal vivo (GET /contacts/, 2026-08-26):
        // { id, value } — MAI { key, field_value }. "id" è l'id CRM sorgente della
        // definizione campo (qui cf1, già sincronizzata come external_id).
        customFields: [{ id: cf1, value: "Roma" }],
        notes: [
          { id: n1, body: "Primo contatto", userId: null, dateAdded: earlier, dateUpdated: null },
        ],
        tasks: [
          { id: k1, title: "Chiamare", body: "Follow-up", dueDate: new Date(Date.now() + 86400000).toISOString(), completed: false, reminderDate: null, dateAdded: earlier, dateUpdated: now },
        ],
      },
      {
        id: c2, email: em("jane"), firstName: "Jane", lastName: "Roe",
        tags: [], dateAdded: earlier, dateUpdated: earlier,
        customFields: [],
        notes: [], tasks: [],
      },
    ],
  };
}

describe("source-sync core mappers (M1)", () => {
  let server, baseUrl;
  let site;
  let fixture;

  const makeCtx = (overrides = {}) => {
    const stats = {};
    const addStat = (res, key, n = 1) => {
      stats[res] = stats[res] || { fetched: 0, upserted: 0, updated: 0, skipped: 0, errors: 0 };
      stats[res][key] = (stats[res][key] || 0) + n;
    };
    return {
      siteId: site.id,
      cfg,
      client,
      dryRun: false,
      stats,
      addStat,
      knownContacts: new Set(),
      discoveredContacts: new Set(),
      log: () => {},
      ...overrides,
    };
  };

  let client, cfg;

  before(async () => {
    site = await createTestSite("Source Sync Core");
    fixture = buildFixture();
    const mock = await createMockSource(fixture);
    baseUrl = mock.url;
    server = mock.server;

    cfg = {
      site_id: site.id,
      base_url: baseUrl,
      location_id: "loc-test",
      company_id: "company-test",
      token: "test-token",
      throttle_rps: 200,
      daily_quota: 1000000,
      budget_percent: 30,
    };
    client = createSourceClient(cfg);
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await closeDb();
  });

  test("primo sync: users/fields/tags/pipelines/contacts con date fedeli", async () => {
    const ctx = makeCtx();

    await usersMapper.syncAll(ctx);
    assert.equal(ctx.stats.users.fetched, 2);
    assert.equal(ctx.stats.users.upserted, 2);
    const alice = (await query("SELECT external_id, role FROM users WHERE email=$1", [fixture.emails.alice])).rows[0];
    assert.equal(alice.external_id, fixture.ids.u1);
    assert.equal(alice.role, "admin", "u.roles.role (oggetto annidato), non u.role, deve essere letto correttamente");
    const bob = (await query("SELECT role FROM users WHERE email=$1", [fixture.emails.bob])).rows[0];
    assert.equal(bob.role, "collaboratore", "roles.role='user' (non 'admin') deve mappare a 'collaboratore'");

    await customFieldsMapper.syncAll(ctx);
    assert.equal(ctx.stats["custom-fields"].upserted, 3);
    const cfCount = (await query("SELECT count(*)::int AS n FROM custom_fields WHERE site_id=$1", [site.id])).rows[0].n;
    assert.equal(cfCount, 3);

    await tagsMapper.syncAll(ctx);
    assert.equal(ctx.stats.tags.upserted, 3);

    await pipelinesMapper.syncAll(ctx);
    assert.equal(ctx.stats.pipelines.upserted, 1);
    const pl = (await query("SELECT id, external_id FROM pipelines WHERE site_id=$1", [site.id])).rows[0];
    assert.equal(pl.external_id, fixture.ids.p1);
    const stages = (await query("SELECT count(*)::int AS n FROM pipeline_stages WHERE pipeline_id=$1", [pl.id])).rows[0].n;
    assert.equal(stages, 2);
    const stExt = (await query("SELECT external_id FROM pipeline_stages WHERE pipeline_id=$1 ORDER BY position LIMIT 1", [pl.id])).rows[0];
    assert.equal(stExt.external_id, fixture.ids.st1);

    // Contatti con hook di pagina: l'orchestratore cacca le figlie per pagina
    await contactsMapper.syncAll(ctx, async (pageExtIds) => {
      assert.equal(pageExtIds.length, 2);
      await contactsMapper.syncForContacts(ctx, pageExtIds);
    });
    assert.equal(ctx.stats.contacts.fetched, 2);
    assert.ok(ctx.stats.contacts.upserted >= 2);

    const john = (await query("SELECT external_id, created_at, updated_at FROM contacts WHERE email=$1 AND site_id=$2", [fixture.emails.john, site.id])).rows[0];
    assert.equal(john.external_id, fixture.ids.c1);
    assert.equal(new Date(john.created_at).toISOString(), fixture.contacts[0].dateAdded);
    assert.equal(new Date(john.updated_at).toISOString(), fixture.contacts[0].dateUpdated);

    // Profilo in custom_values + customField importato
    const cv = (await query(
      `SELECT values FROM contact_custom_values WHERE site_id=$1 AND contact_id=(SELECT id FROM contacts WHERE external_id=$2)`,
      [site.id, fixture.ids.c1]
    )).rows[0];
    assert.equal(cv?.values?.firstName, "John");
    assert.equal(cv?.values?.companyName, "ACME");
    assert.equal(cv?.values?.citta, "Roma", "customField {id,value} risolto sul field_key locale via external_id");

    // Nota e task con linkage
    const note = (await query("SELECT external_id, contact_email, created_at FROM contact_notes WHERE site_id=$1", [site.id])).rows[0];
    assert.equal(note.external_id, fixture.ids.n1);
    assert.equal(new Date(note.created_at).toISOString(), fixture.contacts[0].notes[0].dateAdded);
    const task = (await query("SELECT title, status, due_at FROM tasks WHERE site_id=$1 AND external_id IS NOT NULL", [site.id])).rows[0];
    assert.equal(task.title, "Chiamare");
    assert.equal(task.status, "open");
    assert.ok(task.due_at);
  });

  test("secondo sync: idempotenza S4 (tutto skipped)", async () => {
    const ctx = makeCtx();
    await usersMapper.syncAll(ctx);
    await customFieldsMapper.syncAll(ctx);
    await tagsMapper.syncAll(ctx);
    await pipelinesMapper.syncAll(ctx);
    assert.equal(ctx.stats.users.upserted + ctx.stats.users.updated, 0, "users non riscritti");
    assert.equal(ctx.stats.tags.upserted + ctx.stats.tags.updated, 0, "tags non riscritti");
    await contactsMapper.syncAll(ctx, async (ids) => {
      await contactsMapper.syncForContacts(ctx, ids);
    });
    // i contatti NON cambiano (stessa dateUpdated del sorgente)
    assert.equal(ctx.stats.contacts.upserted + ctx.stats.contacts.updated, 0, "contatti non riscritti");
  });

  test("dry-run: nessuna scrittura", async () => {
    const before = (await query("SELECT count(*)::int AS n FROM contacts WHERE site_id=$1", [site.id])).rows[0].n;
    const ctx = makeCtx({ dryRun: true });
    await contactsMapper.syncAll(ctx, async (ids) => {
      await contactsMapper.syncForContacts(ctx, ids);
    });
    const after = (await query("SELECT count(*)::int AS n FROM contacts WHERE site_id=$1", [site.id])).rows[0].n;
    assert.equal(before, after);
  });

  test("adozione S1: contatto locale stessa email senza external_id viene adottato", async () => {
    // Simula un contatto creato localmente PRIMA dell'import: rimuovi la riga
    // importata di Jane e ricrea la stessa email senza external_id.
    await query("DELETE FROM contacts WHERE email=$1 AND site_id=$2", [fixture.emails.jane, site.id]);
    await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1,$2,'active')",
      [site.id, "jane@example.test"]
    );
    const ctx = makeCtx();
    await contactsMapper.syncAll(ctx);
    const jane = (await query(
      "SELECT external_id, updated_at FROM contacts WHERE email=$1 AND site_id=$2",
      [fixture.emails.jane, site.id]
    )).rows[0];
    assert.equal(jane.external_id, fixture.ids.c2, "external_id adottato dal sorgente");
  });

  test("fetchSingle: contatto singolo dalla ricorsione", async () => {
    const ctx = makeCtx();
    const row = await contactsMapper.fetchSingle(ctx, fixture.ids.c1);
    assert.ok(row && row.email === fixture.emails.john);
  });

  test("users: senza company_id, salta il sync con un errore invece di chiamare /users/search (400/404 reale su CRM sorgente)", async () => {
    const cfgNoCompany = { ...cfg, company_id: "" };
    const clientNoCompany = createSourceClient(cfgNoCompany);
    const ctx = makeCtx({ cfg: cfgNoCompany, client: clientNoCompany });
    await usersMapper.syncAll(ctx);
    assert.equal(ctx.stats.users?.fetched, 0, "nessuna chiamata API senza company_id");
    assert.equal(ctx.stats.users?.errors, 1, "un errore loggato, non un throw silenzioso o un fetch a vuoto");
  });
});
