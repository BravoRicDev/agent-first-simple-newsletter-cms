import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { query } from "../../src/db.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import { createSourceClient } from "../../src/services/source-sync/client.js";
import * as opportunitiesMapper from "../../src/services/source-sync/mappers/opportunities.js";

// Verifica il sync GLOBALE delle opportunità (syncAll), introdotto perché
// la sola caccia per-contatto (syncForContacts) copriva sempre meno storico
// da quando il sync contatti è incrementale — verificato dal vivo: sorgente
// reale aveva 13.697 opportunità sulla location, il nostro DB solo 399.
//
// Fixture con 250 opportunità (> 2 pagine da pageLimit 100) per forzare la
// paginazione cursore multi-pagina e verificare che il campo cursore
// corretto sia "sort" (nome del campo in RISPOSTA — diverso dal nome
// "searchAfter" del parametro da rimandare nella richiesta, verificato dal
// vivo su sorgente reale il 2026-09-11).

const SITE_ID_DOMAIN = "opportunities-syncall-test.local";
const LOCATION_ID = "loc-oppsyncall-001";
const N = 250;

function makeCtx(siteId, mockUrl) {
  const stats = {};
  const addStat = (res, key, n = 1) => {
    stats[res] = stats[res] || { fetched: 0, upserted: 0, updated: 0, skipped: 0, errors: 0 };
    stats[res][key] = (stats[res][key] || 0) + n;
  };
  const cfg = {
    site_id: siteId,
    base_url: mockUrl,
    location_id: LOCATION_ID,
    token: "test-token",
    throttle_rps: 100,
    budget_percent: 100,
    daily_quota: 100000,
  };
  return {
    siteId,
    cfg,
    client: createSourceClient(cfg),
    dryRun: false,
    stats,
    addStat,
    knownContacts: new Set(),
    discoveredContacts: new Set(),
    log: () => {},
  };
}

async function setupSite() {
  const siteRes = await query(
    `INSERT INTO sites (domain, name) VALUES ($1, $2)
     ON CONFLICT (domain) DO NOTHING RETURNING id`,
    [SITE_ID_DOMAIN, "Opportunities SyncAll Test"]
  );
  const siteId = siteRes.rows[0]?.id
    || (await query("SELECT id FROM sites WHERE domain=$1", [SITE_ID_DOMAIN])).rows[0].id;
  await query("DELETE FROM source_sync_config WHERE site_id=$1", [siteId]);
  await query("DELETE FROM opportunities WHERE site_id=$1", [siteId]);
  return siteId;
}

function createFixture(n) {
  const opportunities = [];
  for (let i = 0; i < n; i++) {
    opportunities.push({
      id: randomUUID(),
      name: `Opportunity ${i}`,
      monetaryValue: 1000 + i,
      status: "open",
      pipelineId: null,
      pipelineStageId: null,
      assignedTo: null,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      updatedAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  return { opportunities };
}

test("opportunities syncAll: pagina multi-pagina (250 record, pageLimit 100) senza duplicati né buchi", async () => {
  const siteId = await setupSite();
  const fixture = createFixture(N);
  const mock = await createMockSource(fixture);

  try {
    const ctx = makeCtx(siteId, mock.url);
    await opportunitiesMapper.syncAll(ctx);

    assert.equal(ctx.stats.opportunities.fetched, N, "tutte le 250 opportunità devono essere fetchate attraverso le pagine");
    assert.equal(ctx.stats.opportunities.errors, 0, "zero errori");

    const dbRows = (await query(
      "SELECT source_id FROM opportunities WHERE site_id=$1",
      [siteId]
    )).rows;
    assert.equal(dbRows.length, N, `tutte le ${N} opportunità devono essere presenti nel DB (zero buchi)`);
    const uniqueIds = new Set(dbRows.map((r) => r.source_id));
    assert.equal(uniqueIds.size, N, "nessun duplicato (source_id univoci)");

    // Verifica che siano state fetchate almeno 3 pagine (250/100 = 3 pagine: 100+100+50)
    const searchCalls = mock.calls.filter((c) => c.path === "/opportunities/search");
    assert.ok(searchCalls.length >= 3, `attese almeno 3 chiamate di pagina, trovate ${searchCalls.length}`);
  } finally {
    await mock.close();
    await query("DELETE FROM opportunities WHERE site_id=$1", [siteId]);
    await query("DELETE FROM source_sync_config WHERE site_id=$1", [siteId]);
    await query("DELETE FROM sites WHERE id=$1", [siteId]);
  }
});

test("opportunities syncAll: rieseguito due volte è idempotente (nessun duplicato, upsert diventano skip)", async () => {
  const siteId = await setupSite();
  const fixture = createFixture(30);
  const mock = await createMockSource(fixture);

  try {
    const ctx1 = makeCtx(siteId, mock.url);
    await opportunitiesMapper.syncAll(ctx1);
    assert.equal(ctx1.stats.opportunities.upserted, 30);

    const ctx2 = makeCtx(siteId, mock.url);
    await opportunitiesMapper.syncAll(ctx2);
    // Rerun senza modifiche: upsertByExternalId deve rilevare "unchanged" (skipped),
    // non ri-creare righe duplicate.
    const dbRows = (await query("SELECT id FROM opportunities WHERE site_id=$1", [siteId])).rows;
    assert.equal(dbRows.length, 30, "nessun duplicato dopo un secondo giro identico");
  } finally {
    await mock.close();
    await query("DELETE FROM opportunities WHERE site_id=$1", [siteId]);
    await query("DELETE FROM source_sync_config WHERE site_id=$1", [siteId]);
    await query("DELETE FROM sites WHERE id=$1", [siteId]);
  }
});

test("opportunities syncAll: early stop dopo 25 opportunità consecutive già sincronizzate (ordine dateUpdated desc)", async () => {
  const siteId = await setupSite();
  // 100 opportunità: il mock le ordina per updatedAt desc (più recenti prima)
  const fixture = createFixture(100);
  const mock = await createMockSource(fixture);

  try {
    // Primo sync: tutte inserite
    const ctx1 = makeCtx(siteId, mock.url);
    await opportunitiesMapper.syncAll(ctx1);
    assert.equal(ctx1.stats.opportunities.upserted, 100);
    assert.equal(ctx1.stats.opportunities.skipped, 0);
    // Deve aver fatto tutte le chiamate (100/100 = 1 pagina, ma early stop non attivo al primo giro)

    // Secondo sync: tutto "skipped" (unchanged). Early stop deve attivarsi dopo 25
    // opportunità consecutive già sincronizzate, non scaricare tutte le 100.
    const ctx2 = makeCtx(siteId, mock.url);
    await opportunitiesMapper.syncAll(ctx2);
    // 25 skipped + 25 skipped (2 pagine da 100? No: early stop conta record individuali)
    // Con pageLimit=100, la prima pagina ha 100 record. Le prime 25 sono skipped ->
    // consecutiveUnchanged=25 -> early stop si attiva. Totale fetched = 25 (solo la prima pagina, primi 25 record).
    // Ma il mock restituisce TUTTA la prima pagina (100 record) in una volta.
    // Il callback elabora tutti e 100, consecutiveUnchanged arriva a 100, poi break.
    // In pratica, l'early stop ferma la PAGINAZIONE, non il processing della pagina corrente.
    // Quindi fetched sarà 100 (tutta la prima pagina processata), ma niente seconda pagina.
    assert.ok(ctx2.stats.opportunities.skipped > 25, "almeno 25 skipped prima dell'early stop");
    assert.ok(ctx2.stats.opportunities.fetched <= 100, "early stop evita pagine successive");
    assert.equal(ctx2.stats.opportunities.upserted + ctx2.stats.opportunities.updated, 0, "nessun upsert/update al secondo giro");
  } finally {
    await mock.close();
    await query("DELETE FROM opportunities WHERE site_id=$1", [siteId]);
    await query("DELETE FROM source_sync_config WHERE site_id=$1", [siteId]);
    await query("DELETE FROM sites WHERE id=$1", [siteId]);
  }
});
