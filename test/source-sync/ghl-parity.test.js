import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { recordComparison, isPassthroughActive, PARITY_THRESHOLD } from "../../src/services/ghl-parity.js";

// Motore generico di shadow-comparison clone/GHL (db/152_ghl_parity_tracking.sql).
// Richiesta utente: dopo 100 confronti CONSECUTIVI identici (per sito +
// endpoint) si smette di interrogare GHL per quella coppia; un solo
// confronto diverso azzera il contatore e fa ripartire la verifica.

const ENDPOINT = "GET /test/parity-endpoint";

async function setupConfig(siteId, { dailyQuota = 5 } = {}) {
  await query(
    `INSERT INTO source_sync_config (site_id, enabled, base_url, location_id, shadow_daily_quota)
     VALUES ($1, true, 'http://mock.test', 'loc-parity-test', $2)
     ON CONFLICT (site_id) DO UPDATE SET enabled = true, shadow_daily_quota = EXCLUDED.shadow_daily_quota,
       shadow_calls_count = 0, shadow_calls_date = NULL`,
    [siteId, dailyQuota]
  );
}

async function getState(siteId, endpoint = ENDPOINT) {
  return (await query(
    "SELECT * FROM ghl_parity_state WHERE site_id = $1 AND endpoint = $2",
    [siteId, endpoint]
  )).rows[0] || null;
}

async function lastLog(siteId, endpoint = ENDPOINT) {
  return (await query(
    "SELECT * FROM ghl_parity_log WHERE site_id = $1 AND endpoint = $2 ORDER BY id DESC LIMIT 1",
    [siteId, endpoint]
  )).rows[0];
}

describe("ghl-parity: shadow-comparison clone/GHL con soglia e budget separato", () => {
  let site;

  before(async () => {
    site = await createTestSite("GHL Parity Test");
  });

  after(async () => {
    await query("DELETE FROM ghl_parity_log WHERE site_id = $1", [site.id]);
    await query("DELETE FROM ghl_parity_state WHERE site_id = $1", [site.id]);
    await query("DELETE FROM source_sync_config WHERE site_id = $1", [site.id]);
    await closeDb();
  });

  beforeEach(async () => {
    await query("DELETE FROM ghl_parity_log WHERE site_id = $1", [site.id]);
    await query("DELETE FROM ghl_parity_state WHERE site_id = $1", [site.id]);
    await setupConfig(site.id, { dailyQuota: 1000 });
  });

  test("confronto identico incrementa il contatore a 1 e logga match=true", async () => {
    await recordComparison({
      siteId: site.id, endpoint: ENDPOINT, requestKey: "r1",
      clonePayload: { a: 1 }, fetchReal: async () => ({ a: 1 }),
    });
    const state = await getState(site.id);
    assert.equal(state.consecutive_successes, 1);
    assert.equal(state.passthrough_since, null);
    const log = await lastLog(site.id);
    assert.equal(log.match, true);
    assert.equal(log.skip_reason, null);
  });

  test("un confronto diverso azzera il contatore anche se era già alto", async () => {
    for (let i = 0; i < 5; i++) {
      await recordComparison({ siteId: site.id, endpoint: ENDPOINT, clonePayload: { a: i }, fetchReal: async () => ({ a: i }) });
    }
    assert.equal((await getState(site.id)).consecutive_successes, 5);

    await recordComparison({
      siteId: site.id, endpoint: ENDPOINT,
      clonePayload: { a: "clone" }, fetchReal: async () => ({ a: "diverso" }),
    });
    const state = await getState(site.id);
    assert.equal(state.consecutive_successes, 0, "un mismatch riparte da zero");
    assert.equal(state.passthrough_since, null);
    const log = await lastLog(site.id);
    assert.equal(log.match, false);
  });

  test(`dopo ${PARITY_THRESHOLD} confronti identici consecutivi: passthrough attivo, smette di chiamare GHL`, async () => {
    for (let i = 0; i < PARITY_THRESHOLD; i++) {
      await recordComparison({ siteId: site.id, endpoint: ENDPOINT, clonePayload: { n: i }, fetchReal: async () => ({ n: i }) });
    }
    const state = await getState(site.id);
    assert.equal(state.consecutive_successes, PARITY_THRESHOLD);
    assert.ok(state.passthrough_since, "passthrough_since valorizzato al raggiungimento della soglia");
    assert.equal(await isPassthroughActive(site.id, ENDPOINT), true);

    // Un ulteriore confronto NON deve nemmeno chiamare fetchReal: passthrough attivo.
    let called = false;
    await recordComparison({
      siteId: site.id, endpoint: ENDPOINT, clonePayload: { n: "x" },
      fetchReal: async () => { called = true; return { n: "x" }; },
    });
    assert.equal(called, false, "fetchReal non deve essere invocata quando il passthrough è già attivo");
    assert.equal((await getState(site.id)).consecutive_successes, PARITY_THRESHOLD, "il contatore non deve muoversi oltre in passthrough");
  });

  test("entrambi i payload vuoti: skipReason='both_empty', NON conta né come successo né come fallimento", async () => {
    await recordComparison({ siteId: site.id, endpoint: ENDPOINT, clonePayload: [], fetchReal: async () => [] });
    const state = await getState(site.id);
    assert.equal(state, null, "nessuno stato creato per un confronto sempre saltato");
    const log = await lastLog(site.id);
    assert.equal(log.skip_reason, "both_empty");
    assert.equal(log.match, null);
  });

  test("la chiamata a GHL fallisce (rete/rate-limit): NON conta come mismatch, contatore invariato", async () => {
    await recordComparison({ siteId: site.id, endpoint: ENDPOINT, clonePayload: { a: 1 }, fetchReal: async () => ({ a: 1 }) });
    assert.equal((await getState(site.id)).consecutive_successes, 1);

    await recordComparison({
      siteId: site.id, endpoint: ENDPOINT, clonePayload: { a: 1 },
      fetchReal: async () => { throw new Error("rete irraggiungibile"); },
    });
    const state = await getState(site.id);
    assert.equal(state.consecutive_successes, 1, "un errore di rete non azzera il contatore");
    const log = await lastLog(site.id);
    assert.equal(log.skip_reason, "ghl_call_failed");
    assert.equal(log.match, null);
  });

  test("budget shadow esaurito: la chiamata a GHL non parte nemmeno, skip loggato", async () => {
    await setupConfig(site.id, { dailyQuota: 2 });
    let calls = 0;
    const fetchReal = async () => { calls++; return { a: 1 }; };

    await recordComparison({ siteId: site.id, endpoint: ENDPOINT, clonePayload: { a: 1 }, fetchReal });
    await recordComparison({ siteId: site.id, endpoint: ENDPOINT, clonePayload: { a: 1 }, fetchReal });
    assert.equal(calls, 2, "le prime 2 chiamate entro il budget devono passare");

    await recordComparison({ siteId: site.id, endpoint: ENDPOINT, clonePayload: { a: 1 }, fetchReal });
    assert.equal(calls, 2, "la terza chiamata supera il budget shadow: fetchReal non invocata");
    const log = await lastLog(site.id);
    assert.equal(log.skip_reason, "shadow_budget_exhausted");
  });

  test("comparatore custom (isEquivalent) personalizzato viene rispettato", async () => {
    await recordComparison({
      siteId: site.id, endpoint: ENDPOINT,
      clonePayload: { ids: [2, 1] }, fetchReal: async () => ({ ids: [1, 2] }),
      isEquivalent: (clone, ghl) => ({
        equivalent: JSON.stringify([...clone.ids].sort()) === JSON.stringify([...ghl.ids].sort()),
        skipReason: null,
      }),
    });
    const state = await getState(site.id);
    assert.equal(state.consecutive_successes, 1, "il comparatore custom ignora l'ordine, come previsto");
  });

  test("recordComparison non lancia mai, anche con un comparatore che esplode", async () => {
    await assert.doesNotReject(() =>
      recordComparison({
        siteId: site.id, endpoint: ENDPOINT, clonePayload: { a: 1 }, fetchReal: async () => ({ a: 1 }),
        isEquivalent: () => { throw new Error("comparatore rotto"); },
      })
    );
  });
});
