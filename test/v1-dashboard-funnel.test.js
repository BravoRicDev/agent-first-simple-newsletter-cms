import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { getKpis } from "../src/services/dashboard.js";
import { getFunnel } from "../src/services/tasks.js";

describe("ONDA 3 — v1 dashboard & funnel (service-level)", () => {
  let siteA, siteB;

  before(async () => {
    const ts = Date.now();
    const s1 = await query(
      `INSERT INTO sites (name, domain) VALUES ($1, $2) RETURNING id`,
      [`DVT_A_${ts}`, `dvt-a-${ts}.test`]
    );
    siteA = s1.rows[0].id;
    const s2 = await query(
      `INSERT INTO sites (name, domain) VALUES ($1, $2) RETURNING id`,
      [`DVT_B_${ts}`, `dvt-b-${ts}.test`]
    );
    siteB = s2.rows[0].id;

    // Dati per siteA
    await query(
      `INSERT INTO contacts (site_id, email, status, created_at)
       VALUES ($1, 'dvt-lead@test.com', 'new', NOW())`,
      [siteA]
    );
    await query(
      `INSERT INTO opportunities (site_id, contact_email, title, amount, status)
       VALUES ($1, 'dvt-lead@test.com', 'DVT Opp', 5000, 'open')`,
      [siteA]
    );
    await query(
      `INSERT INTO funnel_snapshots (site_id, day, channel, visits, leads, calls, wins, revenue)
       VALUES ($1, CURRENT_DATE, 'email', 100, 10, 5, 2, 500.00)
       ON CONFLICT (site_id, day, channel)
       DO UPDATE SET visits=EXCLUDED.visits, leads=EXCLUDED.leads,
                     calls=EXCLUDED.calls, wins=EXCLUDED.wins, revenue=EXCLUDED.revenue`,
      [siteA]
    );

    // Dati per siteB (isolato)
    await query(
      `INSERT INTO contacts (site_id, email, status)
       VALUES ($1, 'dvt-other@test.com', 'new')`,
      [siteB]
    );
  });

  after(async () => {
    await query(`DELETE FROM contacts WHERE email LIKE 'dvt-%@test.com'`);
    await query(`DELETE FROM opportunities WHERE contact_email = 'dvt-lead@test.com'`);
    await query(`DELETE FROM funnel_snapshots WHERE site_id IN ($1, $2)`, [siteA, siteB]);
    await query(`DELETE FROM sites WHERE id IN ($1, $2)`, [siteA, siteB]);
  });

  test("getKpis restituisce oggetto con tutte le metriche attese", async () => {
    const result = await getKpis(siteA, { range: "7d" });
    assert.ok(result, "dovrebbe restituire un oggetto");
    assert.equal(typeof result, "object");
    assert.equal(result.range, "7d");
    assert.ok(result.generated_at, "dovrebbe avere generated_at");
    assert.ok(Number.isInteger(result.leads), "leads dovrebbe essere intero");
    assert.ok(result.leads >= 1, "almeno 1 lead");
    assert.ok(Number.isInteger(result.pipeline_value), "pipeline_value intero");
    assert.ok(Number.isInteger(result.open_opportunities), "open_opportunities intero");
    assert.ok(Number.isInteger(result.tasks_open), "tasks_open intero");
    assert.ok(Number.isInteger(result.tasks_overdue), "tasks_overdue intero");
    assert.ok(Number.isInteger(result.conversations_open), "conversations_open intero");
    assert.ok(Array.isArray(result.leads_by_channel), "leads_by_channel array");
    assert.ok(Array.isArray(result.recent_activity), "recent_activity array");
  });

  test("getKpis default range è 30d", async () => {
    const result = await getKpis(siteA);
    assert.equal(result.range, "30d");
  });

  test("getKpis range non valido fallback a 30d", async () => {
    const result = await getKpis(siteA, { range: "999d" });
    assert.equal(result.range, "30d");
  });

  test("getFunnel restituisce array di righe", async () => {
    const funnel = await getFunnel(siteA);
    assert.ok(Array.isArray(funnel), "dovrebbe essere array");
    assert.ok(funnel.length >= 1, "almeno 1 riga funnel");
    const row = funnel[0];
    assert.ok(row.day, "dovrebbe avere day");
    assert.ok(row.channel !== undefined, "dovrebbe avere channel");
    assert.ok(Number.isInteger(row.visits), "visits intero");
    assert.ok(Number.isInteger(row.leads), "leads intero");
    assert.ok(Number.isInteger(row.calls), "calls intero");
    assert.ok(Number.isInteger(row.wins), "wins intero");
    assert.ok(["number", "string"].includes(typeof row.revenue), "revenue numerico o stringa");
  });

  test("getFunnel filtra per data (from/to)", async () => {
    const funnel = await getFunnel(siteA, { from: "2020-01-01", to: "2099-12-31" });
    assert.ok(funnel.length >= 1, "dovrebbe trovare righe nel range ampio");
    const empty = await getFunnel(siteA, { from: "2010-01-01", to: "2010-01-02" });
    assert.equal(empty.length, 0, "range passato dovrebbe dare 0 risultati");
  });

  test("isolamento tenant: siteB non vede dati di siteA", async () => {
    const funnelB = await getFunnel(siteB);
    assert.equal(
      funnelB.filter((r) => r.channel === "email" && r.visits > 0).length,
      0,
      "siteB non dovrebbe avere righe funnel di siteA"
    );

    const kpisB = await getKpis(siteB);
    assert.ok(Number.isInteger(kpisB.leads), "leads di B intero");
  });

  test("getFunnel per site senza dati → array vuoto", async () => {
    const ts2 = Date.now() + 1;
    const emptySite = await query(
      `INSERT INTO sites (name, domain) VALUES ($1, $2) RETURNING id`,
      [`DVT_EMPTY_${ts2}`, `dvt-empty-${ts2}.test`]
    );
    const emptyId = emptySite.rows[0].id;
    try {
      const funnel = await getFunnel(emptyId);
      assert.equal(funnel.length, 0, "sito senza funnel data → array vuoto");
    } finally {
      await query(`DELETE FROM sites WHERE id = $1`, [emptyId]);
    }
  });
});