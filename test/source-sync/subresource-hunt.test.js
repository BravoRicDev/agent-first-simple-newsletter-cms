import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import * as contactsMapper from "../../src/services/source-sync/mappers/contacts.js";

// Regression guard: la caccia delle sotto-risorse (4-5 chiamate API a contatto)
// NON deve più girare per TUTTA la pagina ad ogni giro, ma solo per i contatti
// cambiati — con una caccia COMPLETA periodica (watermark 'contacts-subresources'
// in source_sync_state) che riprende comunque le sotto-risorse aggiunte su un
// contatto invariato (il dateUpdated del contatto padre non le bumpa).
//
// Client finto deterministico (nessuna rete, nessun mock HTTP): paginateSearchSorted
// invoca direttamente l'handler di pagina di syncAll con un array prefissato.

const DA = "2026-01-01T00:00:00.000Z";
const DU = "2026-05-01T12:00:00.000Z";
const DU_OLD = "2026-02-01T00:00:00.000Z";

function fakeClient(pages) {
  return {
    paginateSearchSorted: async (_path, _opts, onPage) => {
      let fetched = 0;
      for (const pg of pages) {
        fetched += pg.length;
        const stop = await onPage(pg);
        if (stop === false) break;
      }
      return { fetched, pages: pages.length };
    },
    get: async () => [],
    paginate: async () => ({ fetched: 0, pages: 0 }),
  };
}

function makeCtx(siteId, client) {
  const stats = {};
  return {
    siteId,
    cfg: { location_id: "loc-test", base_url: "http://mock", company_id: "" },
    client,
    dryRun: false,
    stats,
    addStat: (res, key, n = 1) => { stats[res] = stats[res] || {}; stats[res][key] = (stats[res][key] || 0) + n; },
    knownContacts: new Set(),
    discoveredContacts: new Set(),
    log: () => {},
  };
}

const rnd = () => crypto.randomBytes(4).toString("hex");

async function reset(siteId) {
  await query("DELETE FROM contacts WHERE site_id = $1", [siteId]);
  await query("DELETE FROM source_sync_state WHERE site_id = $1", [siteId]);
}

async function setWatermark(siteId, ageInterval) {
  await query(
    `INSERT INTO source_sync_state (site_id, resource_type, watermark, last_run_at, last_status, last_counts)
     VALUES ($1, 'contacts-subresources', NOW() - ${ageInterval || "interval '0'"}, NOW(), 'ok', '{}')`,
    [siteId]
  );
}

// Semina 4 contatti con azioni controllate: unchanged / updated / adopted / inserted.
async function seedSet(siteId) {
  const sfx = rnd();
  const mk = (name) => ({ id: `ghl-${sfx}-${name}`, email: `${name}-${sfx}@example.test` });
  const unchanged = mk("unchanged");
  const updated = mk("updated");
  const adopted = mk("adopted");
  const created = mk("created");

  await query(
    "INSERT INTO contacts (site_id, email, ghl_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
    [siteId, unchanged.email, unchanged.id, new Date(DA), new Date(DU)]
  );
  await query(
    "INSERT INTO contacts (site_id, email, ghl_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
    [siteId, updated.email, updated.id, new Date(DA), new Date(DU_OLD)]
  );
  await query(
    "INSERT INTO contacts (site_id, email, status) VALUES ($1,$2,'active')",
    [siteId, adopted.email]
  );
  // created: nessuna riga ⇒ inserted

  const page = [unchanged, updated, adopted, created].map((c) => ({
    id: c.id, email: c.email, dateAdded: DA, dateUpdated: DU,
  }));
  return {
    page,
    unchangedId: unchanged.id,
    allIds: [unchanged.id, updated.id, adopted.id, created.id],
    changedIds: [updated.id, adopted.id, created.id],
  };
}

describe("source-sync: caccia sotto-risorse selettiva + sweep periodico", () => {
  let site;
  before(async () => { site = await createTestSite("Subresource Hunt"); });
  after(async () => {
    await query("DELETE FROM contacts WHERE site_id = $1", [site.id]);
    await query("DELETE FROM source_sync_state WHERE site_id = $1", [site.id]);
    await closeDb();
  });

  test("non-due: caccia SOLO i cambiati (inserted/updated/adopted), mai gli unchanged", async () => {
    await reset(site.id);
    await setWatermark(site.id, "interval '0'"); // watermark = ora ⇒ non due
    const { page, changedIds, unchangedId } = await seedSet(site.id);
    let seen = [];
    const ctx = makeCtx(site.id, fakeClient([page]));
    await contactsMapper.syncAll(ctx, async (ids) => { seen = ids.slice(); });
    assert.deepEqual(new Set(seen), new Set(changedIds), "solo i contatti cambiati vengono cacciati");
    assert.ok(!seen.includes(unchangedId), "il contatto unchanged NON deve essere cacciato");
  });

  test("due (watermark assente): caccia COMPLETA della pagina, anche gli unchanged", async () => {
    await reset(site.id); // nessuna watermark ⇒ due
    const { page, allIds } = await seedSet(site.id);
    let seen = [];
    const ctx = makeCtx(site.id, fakeClient([page]));
    await contactsMapper.syncAll(ctx, async (ids) => { seen = ids.slice(); });
    assert.deepEqual(new Set(seen), new Set(allIds), "tutta la pagina cacciata quando è due");
    const wm = (await query(
      "SELECT watermark FROM source_sync_state WHERE site_id=$1 AND resource_type='contacts-subresources'",
      [site.id]
    )).rows[0];
    assert.ok(wm && wm.watermark, "watermark sotto-risorse registrata dopo il full sweep");
  });

  test("due (watermark più vecchia dell'intervallo): caccia completa", async () => {
    await reset(site.id);
    await setWatermark(site.id, "interval '7 hours'");
    const { page, allIds } = await seedSet(site.id);
    let seen = [];
    const ctx = makeCtx(site.id, fakeClient([page]));
    await contactsMapper.syncAll(ctx, async (ids) => { seen = ids.slice(); });
    assert.deepEqual(new Set(seen), new Set(allIds));
  });

  test("non-due e tutto unchanged: onPage MAI chiamato (costo ~0 in regime stabile)", async () => {
    await reset(site.id);
    await setWatermark(site.id, "interval '0'");
    const sfx = rnd();
    const c = { id: `ghl-${sfx}-only`, email: `only-${sfx}@example.test` };
    await query(
      "INSERT INTO contacts (site_id, email, ghl_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      [site.id, c.email, c.id, new Date(DA), new Date(DU)]
    );
    let called = false;
    const ctx = makeCtx(site.id, fakeClient([[{ id: c.id, email: c.email, dateAdded: DA, dateUpdated: DU }]]));
    await contactsMapper.syncAll(ctx, async () => { called = true; });
    assert.equal(called, false, "nessuna caccia quando non è due e nulla è cambiato");
    assert.equal(ctx.stats.contacts.skipped, 1, "contatto contato come skipped (unchanged)");
  });
});
