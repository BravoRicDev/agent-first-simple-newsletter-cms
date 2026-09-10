import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { resolveSiblingSource } from "../../src/services/source-sync/clone-sibling.js";

// Regression guard db/129_sync_master_slave.sql: il rapporto master/slave è
// esplicito e NON dipende più dai conteggi contatti (la vecchia
// findSiblingWithContacts sceglieva con ORDER BY COUNT DESC → ambigua e
// simmetrica quando i conteggi erano uguali ⇒ nessuno chamava più GHL).

const LOC = "loc-master-slave-test";
const BASE = "http://mock.test";

async function upsertConfig(siteId, { enabled = true, masterId = null, base = BASE, location = LOC } = {}) {
  await query(
    `INSERT INTO source_sync_config (site_id, enabled, base_url, location_id, token_enc, sync_master_site_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (site_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       base_url = EXCLUDED.base_url,
       location_id = EXCLUDED.location_id,
       token_enc = EXCLUDED.token_enc,
       sync_master_site_id = EXCLUDED.sync_master_site_id`,
    [siteId, enabled, base, location, "dummy-enc", masterId]
  );
}

async function seedContacts(siteId, n) {
  const esuf = crypto.randomBytes(4).toString("hex");
  for (let i = 0; i < n; i++) {
    await query(
      `INSERT INTO contacts (site_id, email, ghl_id, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW())`,
      [siteId, `ms-${esuf}-${i}@example.test`, `ghl-${esuf}-${i}`]
    );
  }
}

describe("source-sync: master/slave esplicito (db/129)", () => {
  let master, slave, rich;
  before(async () => {
    master = await createTestSite("MS master");
    slave = await createTestSite("MS slave");
    rich = await createTestSite("MS rich");
  });
  after(async () => {
    const ids = [master.id, slave.id, rich.id];
    await query("DELETE FROM contacts WHERE site_id = ANY($1)", [ids]);
    await query("DELETE FROM source_sync_config WHERE site_id = ANY($1)", [ids]);
    await closeDb();
  });

  test("MASTER non clona mai, anche se un altro sito ha molti più contatti", async () => {
    await seedContacts(master.id, 1);
    await seedContacts(rich.id, 100); // "gemello" ricchissimo
    await upsertConfig(master.id, { masterId: null });
    await upsertConfig(rich.id, { masterId: null });
    // Il vecchio findSiblingWithContacts avrebbe potuto far clonare il master
    // dal sito più ricco; ora un master (sync_master_site_id NULL) va sempre
    // a GHL reale.
    const cfg = { sync_master_site_id: null, base_url: BASE, location_id: LOC };
    const r = await resolveSiblingSource(master.id, cfg);
    assert.equal(r.mode, "master");
    assert.equal(r.cloneFrom, null);
    assert.equal(r.skip, false);
  });

  test("SLAVE clona SEMPRE dal master designato, anche con MENO contatti e con un terzo sito più ricco", async () => {
    await query("DELETE FROM contacts WHERE site_id = ANY($1)", [[master.id, slave.id, rich.id]]);
    await seedContacts(master.id, 5);
    await seedContacts(slave.id, 0); // slave senza contatti
    await seedContacts(rich.id, 999); // terzo sito ricchissimo ma NON il master
    await upsertConfig(master.id, { masterId: null });
    await upsertConfig(slave.id, { masterId: master.id });
    await upsertConfig(rich.id, { masterId: null });
    const cfg = { sync_master_site_id: master.id, base_url: BASE, location_id: LOC };
    const r = await resolveSiblingSource(slave.id, cfg);
    assert.equal(r.mode, "slave");
    assert.equal(r.cloneFrom, master.id); // il master esplicito, NON "rich"
    assert.equal(r.skip, false);
  });

  test("SLAVE salta (nessun fallback a sync reale) se il master è disabilitato", async () => {
    await upsertConfig(master.id, { enabled: false, masterId: null });
    await upsertConfig(slave.id, { masterId: master.id });
    const cfg = { sync_master_site_id: master.id, base_url: BASE, location_id: LOC };
    const r = await resolveSiblingSource(slave.id, cfg);
    assert.equal(r.mode, "slave");
    assert.equal(r.cloneFrom, null);
    assert.equal(r.skip, true);
  });

  test("catene non supportate: se il master è a sua volta slave ⇒ skip", async () => {
    await upsertConfig(rich.id, { masterId: null });
    await upsertConfig(master.id, { enabled: true, masterId: rich.id }); // master → slave di rich
    await upsertConfig(slave.id, { masterId: master.id }); // slave → master (che è slave)
    const cfg = { sync_master_site_id: master.id, base_url: BASE, location_id: LOC };
    const r = await resolveSiblingSource(slave.id, cfg);
    assert.equal(r.skip, true);
    assert.equal(r.cloneFrom, null);
  });

  test("account diversi (location diversa) ⇒ skip, non clonazione", async () => {
    await upsertConfig(master.id, { enabled: true, masterId: null, location: "loc-A" });
    await upsertConfig(slave.id, { masterId: master.id, location: "loc-B" });
    const cfg = { sync_master_site_id: master.id, base_url: BASE, location_id: "loc-B" };
    const r = await resolveSiblingSource(slave.id, cfg);
    assert.equal(r.skip, true);
    assert.equal(r.cloneFrom, null);
  });
});
