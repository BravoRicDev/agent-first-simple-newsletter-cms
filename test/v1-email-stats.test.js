import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import { getEmailStatsAggregate, listEmailStatsCampaigns } from "../src/services/newsletter-stats.js";

describe("ONDA 3 — v1 email-stats (service-level)", () => {
  let siteA, siteB;
  let campaignId, subscriberId;

  before(async () => {
    siteA = (await createTestSite("DVE Tenant A")).id;
    siteB = (await createTestSite("DVE Tenant B")).id;

    const sub1 = await query(
      `INSERT INTO newsletter_subscribers (site_id, email, token) VALUES ($1, $2, $3) RETURNING id`,
      [siteA, uniqueEmail("sub"), `tok_${Math.random().toString(36).slice(2)}`]
    );
    const sub2 = await query(
      `INSERT INTO newsletter_subscribers (site_id, email, token) VALUES ($1, $2, $3) RETURNING id`,
      [siteA, uniqueEmail("sub2"), `tok_${Math.random().toString(36).slice(2)}`]
    );
    const sub1Id = sub1.rows[0].id;
    const sub2Id = sub2.rows[0].id;

    const camp = await query(
      `INSERT INTO newsletter_campaigns (site_id, subject, status, sent_at)
       VALUES ($1, 'Campagna Test', 'sent', NOW()) RETURNING id`,
      [siteA]
    );
    campaignId = camp.rows[0].id;

    // 2 send su subscriber distinti: 1 aperta, 1 non aperta
    await query(
      `INSERT INTO newsletter_sends (campaign_id, subscriber_id, sent_at, opened_at, open_count)
       VALUES ($1, $2, NOW(), NOW(), 1), ($1, $3, NOW(), NULL, 0)`,
      [campaignId, sub1Id, sub2Id]
    );

    // click event per siteA (relativo alla send aperta)
    await query(
      `INSERT INTO newsletter_send_events (site_id, send_id, kind, event_type, url, email)
       VALUES ($1, (SELECT id FROM newsletter_sends WHERE campaign_id = $2 AND opened_at IS NOT NULL LIMIT 1), 'campaign', 'click', 'https://x.test/a', $3)`,
      [siteA, campaignId, uniqueEmail("clicker")]
    );
  });

  after(async () => {
    await query(`DELETE FROM newsletter_send_events WHERE site_id IN ($1, $2)`, [siteA, siteB]);
    await query(`DELETE FROM newsletter_sends WHERE campaign_id = $1`, [campaignId]);
    await query(`DELETE FROM newsletter_campaigns WHERE id = $1`, [campaignId]);
    await query(`DELETE FROM newsletter_subscribers WHERE site_id IN ($1, $2)`, [siteA, siteB]);
    await query(`DELETE FROM sites WHERE id IN ($1, $2)`, [siteA, siteB]);
    await closeDb();
  });

  test("getEmailStatsAggregate conta invii e aperture del tenant", async () => {
    const stats = await getEmailStatsAggregate(siteA);
    assert.equal(stats.total, 2, "2 invii");
    assert.equal(stats.opened, 1, "1 apertura");
    assert.equal(stats.open_rate, 0.5);
    assert.ok(Number.isInteger(stats.sent));
  });

  test("listEmailStatsCampaigns restituisce campagne con stats", async () => {
    const campaigns = await listEmailStatsCampaigns(siteA);
    assert.ok(Array.isArray(campaigns));
    assert.ok(campaigns.length >= 1);
    const c = campaigns.find((x) => x.id === campaignId);
    assert.ok(c, "dovrebbe trovare la campagna");
    assert.equal(c.subject, "Campagna Test");
    assert.equal(c.status, "sent");
    assert.equal(c.total, 2);
    assert.equal(c.opened, 1);
    assert.ok("click_rate" in c);
    assert.ok("ctor" in c);
  });

  test("isolamento tenant: siteB non ha campagne/stats di siteA", async () => {
    const campB = await listEmailStatsCampaigns(siteB);
    assert.equal(campB.length, 0, "siteB senza campagne");
    const aggB = await getEmailStatsAggregate(siteB);
    assert.equal(aggB.total, 0);
    assert.equal(aggB.opened, 0);
    assert.equal(aggB.open_rate, 0);
  });
});
