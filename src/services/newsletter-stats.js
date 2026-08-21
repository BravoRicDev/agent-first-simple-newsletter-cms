import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Statistiche email (open/click) per campagna e sequenza — alimentate da
// newsletter_send_events (click con URL) + opened_at/open_count esistenti.
// ─────────────────────────────────────────────────────────────────────────

export async function getEmailStatsCampaign(siteId, campaignId) {
  const campaign = (await query(
    "SELECT id, subject, status, sent_at FROM newsletter_campaigns WHERE id = $1 AND site_id = $2",
    [campaignId, siteId]
  )).rows[0];
  if (!campaign) return { error: "Campagna non trovata" };

  const sends = (await query(
    `SELECT COUNT(*) AS total,
            COUNT(opened_at) AS opened,
            COALESCE(SUM(open_count), 0) AS open_events
     FROM newsletter_sends WHERE campaign_id = $1`,
    [campaignId]
  )).rows[0];

  const events = (await query(
    `SELECT event_type, url, COUNT(*) AS c
     FROM newsletter_send_events
     WHERE send_id = $1 AND kind = 'campaign'
     GROUP BY event_type, url ORDER BY c DESC LIMIT 20`,
    [campaignId]
  )).rows;

  const clicks = (await query(
    `SELECT COUNT(DISTINCT email) AS clickers, COUNT(*) AS click_events
     FROM newsletter_send_events WHERE send_id = $1 AND kind = 'campaign' AND event_type = 'click'`,
    [campaignId]
  )).rows[0];

  const total = parseInt(sends?.total || 0, 10);
  const opened = parseInt(sends?.opened || 0, 10);
  const clickers = parseInt(clicks?.clickers || 0, 10);

  return {
    campaign,
    total,
    opened,
    open_rate: total > 0 ? +(opened / total).toFixed(4) : 0,
    clickers,
    click_rate: total > 0 ? +(clickers / total).toFixed(4) : 0,
    ctor: opened > 0 ? +(clickers / opened).toFixed(4) : 0,
    events,
  };
}

export async function getEmailStatsSequence(siteId, sequenceId) {
  const sequence = (await query(
    "SELECT id, name, active FROM newsletter_sequences WHERE id = $1 AND site_id = $2",
    [sequenceId, siteId]
  )).rows[0];
  if (!sequence) return { error: "Sequenza non trovata" };

  const steps = (await query(
    `SELECT st.id, st.step_order, st.delay_days, st.subject,
            COUNT(se.id) AS sent, COUNT(se.opened_at) AS opened
     FROM newsletter_sequence_steps st
     LEFT JOIN newsletter_sequence_sends se ON se.step_id = st.id
     WHERE st.sequence_id = $1
     GROUP BY st.id ORDER BY st.step_order`,
    [sequenceId]
  )).rows;

  const events = (await query(
    `SELECT event_type, url, COUNT(*) AS c
     FROM newsletter_send_events
     WHERE kind = 'sequence' AND send_id IN (
       SELECT id FROM newsletter_sequence_sends WHERE step_id IN (
         SELECT id FROM newsletter_sequence_steps WHERE sequence_id = $1
       )
     )
     GROUP BY event_type, url ORDER BY c DESC LIMIT 20`,
    [sequenceId]
  )).rows;

  return { sequence, steps, events };
}

// ─────────────────────────────────────────────────────────────────────────
// Statistiche EMAIL aggregate per tenant ed elenco campagne con stats.
// newsletter_sends NON ha site_id: si risale al sito via newsletter_campaigns
// (o a site_id su newsletter_send_events per i click).
// ─────────────────────────────────────────────────────────────────────────

// Stats di click per una campagna (da newsletter_send_events kind='campaign').
async function campaignClicks(campaignId) {
  const r = (await query(
    `SELECT COUNT(DISTINCT email)::int AS clickers,
            COUNT(*)::int AS click_events
     FROM newsletter_send_events
     WHERE kind = 'campaign' AND event_type = 'click'
       AND send_id IN (SELECT id FROM newsletter_sends WHERE campaign_id = $1)`,
    [campaignId]
  )).rows[0];
  return {
    clickers: parseInt(r?.clickers || 0, 10),
    click_events: parseInt(r?.click_events || 0, 10),
  };
}

// Stats invio/opening per una campagna.
async function campaignSends(campaignId) {
  const r = (await query(
    `SELECT COUNT(*)::int AS total, COUNT(opened_at)::int AS opened
     FROM newsletter_sends WHERE campaign_id = $1`,
    [campaignId]
  )).rows[0];
  return {
    total: parseInt(r?.total || 0, 10),
    opened: parseInt(r?.opened || 0, 10),
  };
}

function withRates(total, opened, clickers) {
  return {
    open_rate: total > 0 ? +(opened / total).toFixed(4) : 0,
    click_rate: total > 0 ? +(clickers / total).toFixed(4) : 0,
    ctor: opened > 0 ? +(clickers / opened).toFixed(4) : 0,
  };
}

export async function getEmailStatsAggregate(siteId) {
  const sends = (await query(
    `SELECT COUNT(*)::int AS sent, COUNT(s.opened_at)::int AS opened
     FROM newsletter_sends s
     JOIN newsletter_campaigns c ON c.id = s.campaign_id
     WHERE c.site_id = $1`,
    [siteId]
  )).rows[0];

  const clicks = (await query(
    `SELECT COUNT(DISTINCT email)::int AS clickers, COUNT(*)::int AS click_events
     FROM newsletter_send_events
     WHERE kind = 'campaign' AND event_type = 'click' AND site_id = $1`,
    [siteId]
  )).rows[0];

  const total = parseInt(sends?.sent || 0, 10);
  const opened = parseInt(sends?.opened || 0, 10);
  const clickers = parseInt(clicks?.clickers || 0, 10);

  return {
    total,
    sent: total,
    opened,
    clickers,
    clicks: parseInt(clicks?.click_events || 0, 10),
    ...withRates(total, opened, clickers),
  };
}

export async function listEmailStatsCampaigns(siteId) {
  const campaigns = (await query(
    `SELECT id, subject, status, created_at, sent_at
     FROM newsletter_campaigns WHERE site_id = $1 ORDER BY created_at DESC`,
    [siteId]
  )).rows;

  const result = [];
  for (const c of campaigns) {
    const { total, opened } = await campaignSends(c.id);
    const { clickers, click_events } = await campaignClicks(c.id);
    result.push({
      id: c.id,
      subject: c.subject,
      status: c.status,
      created_at: c.created_at,
      sent_at: c.sent_at,
      total,
      opened,
      clickers,
      clicks: click_events,
      ...withRates(total, opened, clickers),
    });
  }
  return result;
}

