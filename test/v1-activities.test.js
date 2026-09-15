import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";

describe("ONDA 3 — v1 activities (service-level)", () => {
  let siteA, siteB;
  const emailA = uniqueEmail("act");
  const emailOther = uniqueEmail("actb");

  const countActivities = async (siteId, email) => {
    const r = await query(
      "SELECT COUNT(*)::int AS n FROM contact_events WHERE site_id = $1 AND email = $2",
      [siteId, email]
    );
    return r.rows[0].n;
  };

  before(async () => {
    siteA = (await createTestSite("DVA Tenant A")).id;
    siteB = (await createTestSite("DVA Tenant B")).id;
    await query(
      `INSERT INTO contact_events (site_id, email, event_type, payload)
       VALUES ($1, $2, 'contact_created', '{"source":"test"}')`,
      [siteA, emailA]
    );
    await query(
      `INSERT INTO contact_events (site_id, email, event_type, payload)
       VALUES ($1, $2, 'stage_changed', '{"to":"qualified"}')`,
      [siteA, emailA]
    );
    await query(
      `INSERT INTO contact_events (site_id, email, event_type, payload)
       VALUES ($1, $2, 'form_submitted', '{}')`,
      [siteA, emailOther]
    );
    // sito B isolato
    await query(
      `INSERT INTO contact_events (site_id, email, event_type) VALUES ($1, $2, 'manual')`,
      [siteB, emailOther]
    );
  });

  after(async () => {
    await query(`DELETE FROM contact_events WHERE site_id IN ($1, $2)`, [siteA, siteB]);
    await query(`DELETE FROM sites WHERE id IN ($1, $2)`, [siteA, siteB]);
    await closeDb();
  });

  test("contact_events è per-tenant: siteA vede i suoi eventi, non quelli di siteB", async () => {
    const a = await countActivities(siteA, emailA);
    const b = await countActivities(siteB);
    assert.equal(a, 2);
    assert.equal(b, 0, "siteA non deve vedere eventi di siteB");
  });

  test("eventi per-tenant con tutti i campi", async () => {
    const r = await query(
      `SELECT id, email, event_type, payload, created_at FROM contact_events
       WHERE site_id = $1 AND email = $2 ORDER BY id`,
      [siteA, emailA]
    );
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) {
      assert.ok(row.id, "dovrebbe avere id");
      assert.ok(row.created_at, "dovrebbe avere created_at");
      assert.equal(row.email, emailA);
    }
    const types = r.rows.map((x) => x.event_type).sort();
    assert.deepEqual(types, ["contact_created", "stage_changed"]);
  });

  test("filtro per event_type", async () => {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM contact_events
       WHERE site_id = $1 AND event_type = ANY($2::varchar[])`,
      [siteA, ["stage_changed"]]
    );
    assert.equal(r.rows[0].n, 1);
  });

  test("payload JSONB è un oggetto parsato", async () => {
    const r = await query(
      `SELECT payload FROM contact_events WHERE site_id = $1 AND event_type = 'contact_created'`,
      [siteA]
    );
    const payload = r.rows[0].payload;
    assert.equal(typeof payload, "object");
    assert.equal(payload.source, "test");
  });
});
